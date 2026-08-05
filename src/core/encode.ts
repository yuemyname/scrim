/**
 * WebCodecs 인코더 + mp4-muxer 먹싱.
 * 비디오는 재인코딩, 오디오는 원본 청크 무손실 패스스루(addAudioChunkRaw).
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { AudioPassthrough } from './demux';
import { waitDequeue } from './queue';

const MAX_ENCODE_QUEUE = 8;
const KEYFRAME_INTERVAL_US = 2_000_000; // 2초
/**
 * 해상도에 맞는 H.264 레벨을 계산한다.
 * WebKit은 isConfigSupported에서 레벨 초과를 걸러주지 않고 런타임에
 * "Encoding task failed"로 죽는다 — 예: Level 3.1(최대 1280×720)로
 * 세로 1080×1920을 인코딩 시도. 픽셀 수 기준으로 레벨을 고른다.
 */
function codecCandidates(width: number, height: number): string[] {
  const px = width * height;
  // 3.1: ≤921K(720p) / 4.0: ≤2.1M(1080p) / 5.1: ≤9.4M(4K) / 5.2
  const level = px <= 921_600 ? '1F' : px <= 2_097_152 ? '28' : '33';
  return [
    `avc1.42E0${level}`, // Constrained Baseline
    `avc1.4D40${level}`, // Main
    `avc1.6400${level}`, // High
    'avc1.640033',
    'avc1.640034',
  ];
}

export interface EncoderOptions {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audio: AudioPassthrough | null;
  /** true면 부가 옵션(latencyMode/hardwareAcceleration) 없이 최소 설정만 시도 */
  conservative?: boolean;
}

export interface Encoder {
  encodeFrame(frame: VideoFrame): Promise<void>;
  finalize(): Promise<Blob>;
  close(): void;
}

export async function createEncoder(opts: EncoderOptions): Promise<Encoder> {
  // 인코더는 짝수 해상도를 요구한다
  const width = opts.width - (opts.width % 2);
  const height = opts.height - (opts.height % 2);

  const candidates = codecCandidates(width, height);
  // 일부 브라우저는 latencyMode/hardwareAcceleration 조합 자체를 거부한다 → 옵션을 줄여가며 시도
  const extrasChain: Partial<VideoEncoderConfig>[] = opts.conservative
    ? [{}]
    : [{ latencyMode: 'quality', hardwareAcceleration: 'prefer-hardware' }, { latencyMode: 'quality' }, {}];
  let config: VideoEncoderConfig | null = null;
  outer: for (const candidate of candidates) {
    for (const extras of extrasChain) {
      const attempt: VideoEncoderConfig = {
        codec: candidate,
        width,
        height,
        bitrate: opts.bitrate,
        framerate: Math.max(1, Math.round(opts.fps)),
        ...extras,
      };
      const support = await VideoEncoder.isConfigSupported(attempt).catch(() => null);
      if (support?.supported) {
        config = attempt;
        break outer;
      }
    }
  }
  if (!config) throw new Error('이 브라우저에서 H.264 인코딩을 지원하지 않습니다.');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(opts.audio
      ? {
          audio: {
            codec: 'aac' as const,
            numberOfChannels: opts.audio.config.numberOfChannels,
            sampleRate: opts.audio.config.sampleRate,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });

  let error: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (error = e instanceof Error ? e : new Error(String(e))),
  });
  encoder.configure(config);

  let lastKeyUs = -Infinity;

  return {
    async encodeFrame(frame: VideoFrame): Promise<void> {
      if (error) throw error;
      // 백프레셔. dequeue 이벤트 미지원 브라우저 대비 타임아웃 폴백.
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        await waitDequeue(encoder);
        if (error) throw error;
      }
      const keyFrame = frame.timestamp - lastKeyUs >= KEYFRAME_INTERVAL_US;
      if (keyFrame) lastKeyUs = frame.timestamp;
      encoder.encode(frame, { keyFrame });
    },
    async finalize(): Promise<Blob> {
      await encoder.flush();
      if (error) throw error;
      encoder.close();
      for (const a of opts.audio?.chunks ?? []) {
        muxer.addAudioChunkRaw(a.data, a.type, a.timestampUs, a.durationUs);
      }
      muxer.finalize();
      const { buffer } = muxer.target as ArrayBufferTarget;
      return new Blob([buffer], { type: 'video/mp4' });
    },
    close(): void {
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch {
        /* noop */
      }
    },
  };
}

/** 비트레이트 기본값. 원본보다 낮아지지 않게 하한 적용. */
export function defaultBitrate(width: number, height: number, fps: number, sourceFileBytes: number, durationUs: number): number {
  const computed = width * height * fps * 0.09; // 1080p30 ≈ 5.6Mbps
  const durationS = durationUs / 1e6;
  const sourceBitrate = durationS > 0 ? (sourceFileBytes * 8) / durationS : 0;
  return Math.round(Math.max(computed, Math.min(sourceBitrate, 20_000_000)));
}
