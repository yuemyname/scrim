/**
 * 2-패스 파이프라인. 분석과 렌더를 분리해야 사용자가 중간에서 수정할 수 있다.
 *
 * [1] analyze: demux → decode → (다운스케일) → detect → track → Track[]
 *     VideoFrame은 즉시 close(). 좌표만 남긴다. 메모리 상수 유지.
 * [3] render: demux → decode → redact 합성 → encode → mux → Blob
 *     소스를 처음부터 다시 디코드한다. 프레임을 들고 있지 않는다.
 */
import type { Detection, FrameIndex, Progress, Project, RedactStyle, Track } from '../types';
import { DEFAULT_STYLE } from '../types';
import { demux } from './demux';
import { decodeStream } from './decode';
import { createDetector } from './detect';
import { buildTracks, sampleTrackAt } from './track';
import { redactFrame } from './redact';
import { createEncoder, defaultBitrate } from './encode';
import { drawFrameOriented } from './orient';

export interface AnalyzeOptions {
  /** 검출 입력 긴 변. 512 표준 / 768·1024 정밀 모드 */
  longSide: number;
}

export function makeProgressThrottle(onProgress: (p: Progress) => void): (p: Progress) => void {
  // postMessage를 프레임마다 보내면 그것만으로 20% 느려진다 — 80ms로 throttle
  let last = 0;
  return (p: Progress) => {
    const now = performance.now();
    if (now - last > 80 || p.done >= p.total) {
      last = now;
      onProgress(p);
    }
  };
}

class EtaEstimator {
  private start = performance.now();
  eta(done: number, total: number): number {
    if (done <= 0) return 0;
    const elapsed = performance.now() - this.start;
    return Math.round((elapsed / done) * (total - done));
  }
}

export async function analyze(
  file: File,
  opts: AnalyzeOptions,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<{ project: Project; frames: FrameIndex }> {
  const progress = makeProgressThrottle(onProgress);
  progress({ phase: 'demux', done: 0, total: 1, etaMs: 0 });
  const { meta, videoConfig, videoChunks } = await demux(file);
  progress({ phase: 'demux', done: 1, total: 1, etaMs: 0 });

  const detector = await createDetector({
    minConfidence: 0.35,
    longSide: opts.longSide,
    displayWidth: meta.width,
    displayHeight: meta.height,
    rotation: meta.rotation,
  });

  const perFrame: { t: number; detections: Detection[] }[] = [];
  const eta = new EtaEstimator();
  let done = 0;

  try {
    await decodeStream(
      videoChunks,
      videoConfig,
      async (frame) => {
        try {
          const t = frame.timestamp;
          const detections = detector.detect(frame, t);
          perFrame.push({ t, detections });
        } finally {
          // 좌표만 남기고 프레임은 즉시 닫는다
          frame.close();
        }
        done++;
        progress({ phase: 'analyze', done, total: meta.frameCount, etaMs: eta.eta(done, meta.frameCount) });
      },
      signal,
    );
  } finally {
    detector.close();
  }

  perFrame.sort((a, b) => a.t - b.t);
  const discardedShortAt: number[] = [];
  const tracks: Track[] = buildTracks(perFrame, { onDiscard: (t) => discardedShortAt.push(t) });

  const frames: FrameIndex = {
    timestampsUs: perFrame.map((f) => f.t),
    detectionCounts: perFrame.map((f) => f.detections.length),
    discardedShortAt,
  };

  const project: Project = {
    version: 1,
    source: meta,
    tracks,
    globalStyle: { ...DEFAULT_STYLE },
  };

  return { project, frames };
}

export async function render(
  file: File,
  project: Project,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const progress = makeProgressThrottle(onProgress);
  progress({ phase: 'demux', done: 0, total: 1, etaMs: 0 });
  const { meta, videoConfig, videoChunks, audio } = await demux(file);
  progress({ phase: 'demux', done: 1, total: 1, etaMs: 0 });

  const fps = meta.frameCount / Math.max(0.001, meta.durationUs / 1e6);
  const encoder = await createEncoder({
    width: meta.width,
    height: meta.height,
    fps,
    bitrate: defaultBitrate(meta.width, meta.height, fps, file.size, meta.durationUs),
    audio,
  });

  // 렌더 캔버스 (표시 방향, 회전 baked)
  const canvas = new OffscreenCanvas(meta.width, meta.height);
  const ctx = canvas.getContext('2d')!;

  const enabledTracks = project.tracks.filter((t) => t.enabled);
  const styleOf = (t: Track): RedactStyle => t.style ?? project.globalStyle;

  const eta = new EtaEstimator();
  let done = 0;

  try {
    await decodeStream(
      videoChunks,
      videoConfig,
      async (frame) => {
        try {
          if (signal.aborted) return;
          const t = frame.timestamp;
          drawFrameOriented(ctx, frame, meta.rotation, meta.width, meta.height);
          const boxes = [];
          for (const track of enabledTracks) {
            const box = sampleTrackAt(track, t);
            if (box) boxes.push({ box, style: styleOf(track) });
          }
          if (boxes.length > 0) redactFrame(ctx, null, boxes, meta);
          const out = new VideoFrame(canvas, { timestamp: t, duration: frame.duration ?? undefined });
          try {
            await encoder.encodeFrame(out);
          } finally {
            out.close();
          }
        } finally {
          frame.close();
        }
        done++;
        progress({ phase: 'render', done, total: meta.frameCount, etaMs: eta.eta(done, meta.frameCount) });
      },
      signal,
    );

    progress({ phase: 'mux', done: 0, total: 1, etaMs: 0 });
    const blob = await encoder.finalize();
    progress({ phase: 'mux', done: 1, total: 1, etaMs: 0 });
    return blob;
  } catch (e) {
    encoder.close();
    throw e;
  }
}
