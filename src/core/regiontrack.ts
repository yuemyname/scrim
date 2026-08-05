/**
 * 수동 박스 추적: 사용자가 그린 박스의 대상(검출이 놓친 얼굴)을 구간 내내 따라간다.
 *
 * 프레임마다 두 단계:
 *  1. 박스 주변(3×)만 잘라 YuNet으로 확대 검출 — 전체 프레임에서 놓친 작은/측면
 *     얼굴도 확대하면 잡히는 경우가 많다 → source 'detected'
 *  2. 검출 실패 시 그레이스케일 SAD 템플릿 매칭으로 위치만 추정 → source 'interpolated'
 *
 * 결과 샘플은 사용자가 리뷰에서 다시 수정할 수 있는 일반 샘플이다.
 */
import type { Box, Progress, TrackSample } from '../types';
import { demux } from './demux';
import { decodeStream } from './decode';
import { drawVideoFrame } from './orient';
import { createYunetRegionDetector } from './yunet';
import { iou } from './track';
import { makeProgressThrottle } from './pipeline';

export interface TrackRegionOptions {
  startUs: number;
  endUs: number;
  initBox: Box;
  minConfidence?: number;
}

const TPL = 24; // 템플릿 크기 (그레이스케일 24×24)
const SEARCH_RADIUS = Math.max(6, Math.round(TPL * 0.5)); // 템플릿 좌표계 기준 검색 반경 (px)

export async function trackRegion(
  file: File,
  opts: TrackRegionOptions,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<TrackSample[]> {
  const progress = makeProgressThrottle(onProgress);
  progress({ phase: 'demux', done: 0, total: 1, etaMs: 0 });
  const { meta, videoConfig, videoChunks } = await demux(file);
  progress({ phase: 'demux', done: 1, total: 1, etaMs: 0 });

  // 구간 앞 키프레임부터 디코드해야 한다 (리드인 프레임은 버린다)
  let startIdx = 0;
  for (let i = 0; i < videoChunks.length; i++) {
    const c = videoChunks[i];
    if (!c) continue;
    if (c.type === 'key' && c.timestamp <= opts.startUs) startIdx = i;
    if (c.timestamp > opts.endUs) break;
  }
  const slice: EncodedVideoChunk[] = [];
  for (let i = startIdx; i < videoChunks.length; i++) {
    const c = videoChunks[i];
    if (!c) continue;
    slice.push(c);
    // B-frame 재배치 여유를 두고 구간 뒤 0.5초까지 포함
    if (c.timestamp > opts.endUs + 500_000) break;
  }

  const detector = await createYunetRegionDetector(opts.minConfidence ?? 0.35);

  // 작업 캔버스: 표시 방향 전체 프레임 (긴 변 1280이면 크롭→640 입력에 충분)
  const fullScale = Math.min(1, 1280 / Math.max(meta.width, meta.height));
  const fullW = Math.max(2, Math.round(meta.width * fullScale));
  const fullH = Math.max(2, Math.round(meta.height * fullScale));
  const fullCanvas = new OffscreenCanvas(fullW, fullH);
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true })!;
  const cropCanvas = new OffscreenCanvas(2, 2);
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })!;

  const samples: TrackSample[] = [];
  let lastBox: Box = opts.initBox;
  let template: Float32Array | null = null;
  const total = Math.max(1, Math.round(((opts.endUs - opts.startUs) / meta.durationUs) * meta.frameCount));
  let done = 0;

  /** 박스 영역을 TPL×TPL 그레이스케일로 샘플링 */
  const grayPatch = (box: Box): Float32Array => {
    cropCanvas.width = TPL;
    cropCanvas.height = TPL;
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.drawImage(fullCanvas, box.x * fullW, box.y * fullH, box.w * fullW, box.h * fullH, 0, 0, TPL, TPL);
    const d = cropCtx.getImageData(0, 0, TPL, TPL).data;
    const g = new Float32Array(TPL * TPL);
    for (let i = 0; i < g.length; i++) {
      g[i] = (d[i * 4]! + d[i * 4 + 1]! + d[i * 4 + 2]!) / 3;
    }
    return g;
  };

  /**
   * lastBox 주변에서 템플릿과 가장 닮은 위치를 찾는다 (그레이스케일 SAD).
   * 검색 영역은 "박스가 정확히 TPL px가 되는 배율"로 리샘플링한다 —
   * 그래야 템플릿과 스케일이 일치하고, px 오프셋 → 정규화 변환이 단순해진다.
   */
  const sadSearch = (tpl: Float32Array, box: Box): { dx: number; dy: number } | null => {
    const bw = box.w * fullW;
    const bh = box.h * fullH;
    if (bw < 4 || bh < 4) return null;
    const rW = TPL + SEARCH_RADIUS * 2;
    const rH = TPL + SEARCH_RADIUS * 2;
    // 리샘플 배율 유지: region 폭 = box.w × (rW/TPL)
    const region = {
      x: box.x - box.w * (SEARCH_RADIUS / TPL),
      y: box.y - box.h * (SEARCH_RADIUS / TPL),
      w: box.w * (rW / TPL),
      h: box.h * (rH / TPL),
    };
    cropCanvas.width = rW;
    cropCanvas.height = rH;
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.clearRect(0, 0, rW, rH);
    cropCtx.drawImage(
      fullCanvas,
      region.x * fullW,
      region.y * fullH,
      region.w * fullW,
      region.h * fullH,
      0,
      0,
      rW,
      rH,
    );
    const d = cropCtx.getImageData(0, 0, rW, rH).data;
    const gray = new Float32Array(rW * rH);
    for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4]! + d[i * 4 + 1]! + d[i * 4 + 2]!) / 3;

    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let oy = 0; oy <= rH - TPL; oy += 1) {
      for (let ox = 0; ox <= rW - TPL; ox += 1) {
        let sad = 0;
        for (let ty = 0; ty < TPL; ty += 2) {
          const rowR = (oy + ty) * rW + ox;
          const rowT = ty * TPL;
          for (let tx = 0; tx < TPL; tx += 2) {
            sad += Math.abs(gray[rowR + tx]! - tpl[rowT + tx]!);
          }
        }
        if (sad < best) {
          best = sad;
          bx = ox;
          by = oy;
        }
      }
    }
    // 임계: 평균 픽셀 차 40 초과면 놓친 것으로 본다 (장면이 바뀌었거나 가려짐)
    const meanDiff = best / ((TPL / 2) * (TPL / 2));
    if (meanDiff > 40) return null;
    // 리샘플 공간 1px = box.w/TPL (정규화) — (SEARCH_RADIUS,SEARCH_RADIUS)가 원래 박스 위치
    return {
      dx: (bx - SEARCH_RADIUS) * (box.w / TPL),
      dy: (by - SEARCH_RADIUS) * (box.h / TPL),
    };
  };

  try {
    await decodeStream(
      slice,
      videoConfig,
      async (frame) => {
        const ts = frame.timestamp;
        try {
          if (ts < opts.startUs - 1000 || ts > opts.endUs + 1000) return; // 리드인/오버런 프레임
          await drawVideoFrame(fullCtx, frame, meta.rotation, fullW, fullH);

          if (!template) {
            // 첫 구간 프레임: 사용자가 그린 박스로 초기화
            lastBox = opts.initBox;
            template = grayPatch(lastBox);
            samples.push({ t: ts, box: lastBox, source: 'manual' });
            return;
          }

          // 1) 박스 주변 3× 영역 확대 검출
          const search = clampBox(expandBox(lastBox, 3), 0.02);
          const rx = search.x * fullW;
          const ry = search.y * fullH;
          const rw = Math.max(2, search.w * fullW);
          const rh = Math.max(2, search.h * fullH);
          cropCanvas.width = Math.round(rw);
          cropCanvas.height = Math.round(rh);
          cropCtx.imageSmoothingEnabled = true;
          cropCtx.drawImage(fullCanvas, rx, ry, rw, rh, 0, 0, cropCanvas.width, cropCanvas.height);
          const dets = await detector.detect(cropCanvas, cropCanvas.width, cropCanvas.height);

          let matched: Box | null = null;
          let bestScore = 0;
          for (const det of dets) {
            const g: Box = {
              x: search.x + det.box.x * search.w,
              y: search.y + det.box.y * search.h,
              w: det.box.w * search.w,
              h: det.box.h * search.h,
            };
            const cd = centerDist(lastBox, g);
            if (cd > Math.max(lastBox.w, lastBox.h) * 1.2) continue; // 다른 사람일 가능성
            const s = iou(lastBox, g) + det.score * 0.3;
            if (s > bestScore) {
              bestScore = s;
              matched = g;
            }
          }

          if (matched) {
            lastBox = clampBox(lerpBox(lastBox, matched, 0.6), 0);
            template = grayPatch(lastBox);
            samples.push({ t: ts, box: lastBox, source: 'detected' });
          } else {
            // 2) SAD 템플릿 매칭 폴백 — 위치만 추정, 크기 유지
            const offset = sadSearch(template, lastBox);
            if (offset) {
              lastBox = clampBox(
                { x: lastBox.x + offset.dx, y: lastBox.y + offset.dy, w: lastBox.w, h: lastBox.h },
                0,
              );
              template = grayPatch(lastBox);
              samples.push({ t: ts, box: lastBox, source: 'interpolated' });
            } else {
              samples.push({ t: ts, box: lastBox, source: 'held' });
            }
          }
        } finally {
          frame.close();
          if (ts >= opts.startUs) {
            done++;
            progress({ phase: 'analyze', done: Math.min(done, total), total, etaMs: 0 });
          }
        }
      },
      signal,
    );
  } finally {
    detector.close();
  }

  samples.sort((a, b) => a.t - b.t);

  // 사용자가 정한 구간 [startUs, endUs]를 그대로 보존한다 — 디코드된 첫/끝 프레임이
  // 구간 경계와 어긋나면 경계 샘플을 복제해 가림 범위가 줄어들지 않게 한다.
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first && first.t > opts.startUs) samples.unshift({ t: opts.startUs, box: first.box, source: 'manual' });
  if (last && last.t < opts.endUs) samples.push({ t: opts.endUs, box: last.box, source: 'held' });

  return samples;
}

function expandBox(b: Box, f: number): Box {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: cx - (b.w * f) / 2, y: cy - (b.h * f) / 2, w: b.w * f, h: b.h * f };
}

function clampBox(b: Box, minSize: number): Box {
  const w = Math.max(minSize, Math.min(1, b.w));
  const h = Math.max(minSize, Math.min(1, b.h));
  return { x: Math.max(0, Math.min(1 - w, b.x)), y: Math.max(0, Math.min(1 - h, b.y)), w, h };
}

function centerDist(a: Box, b: Box): number {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by);
}

function lerpBox(a: Box, b: Box, alpha: number): Box {
  return {
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    w: a.w + (b.w - a.w) * alpha,
    h: a.h + (b.h - a.h) * alpha,
  };
}
