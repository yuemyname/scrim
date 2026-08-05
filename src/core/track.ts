/**
 * 프레임 독립 검출 → 시간 연속 트랙 변환.
 *
 * 이 앱에서 가장 신경 써야 할 모듈이다. 프레임 독립 검출만 쓰면 블러가
 * 깜빡이고, 깜빡이는 한 프레임이 곧 신원 노출이다.
 *
 * 1. IoU greedy 매칭 (헝가리안까지 갈 필요 없다)
 * 2. 매칭 성공 → EMA 스무딩 ('detected')
 * 3. 매칭 실패 → holdFrames 동안 직전 박스 유지 ('held'), 이후 종료
 * 4. 재매칭되면 공백을 선형 보간으로 대체 ('interpolated')
 * 5. 트랙 양 끝을 holdFrames만큼 연장 — 등장 직전/퇴장 직후가 가장 잘 새는 지점
 * 6. minTrackFrames 미만은 노이즈로 폐기하되 위치를 onDiscard로 알린다
 */
import type { Box, Detection, Track, TrackSample } from '../types';

export interface TrackOptions {
  iouThreshold: number; // 기본 0.3
  holdFrames: number; // 기본 8 — 검출 실패해도 직전 박스 유지
  minTrackFrames: number; // 기본 3 — 이보다 짧으면 노이즈로 폐기
  smoothing: number; // 기본 0.6 — EMA 계수
  /** 폐기된 짧은 검출 알림 (리뷰 UI "짧은 검출 무시됨" 마커) */
  onDiscard?: (t: number) => void;
  /** 장면 전환 프레임 타임스탬프. 유지/연장이 컷을 넘지 않게 한다 —
   *  슬라이드쇼·편집 영상에서 이전 장면의 박스가 다음 장면을 덮는 것 방지 */
  cuts?: number[];
}

const DEFAULTS: TrackOptions = {
  iouThreshold: 0.3,
  holdFrames: 8,
  minTrackFrames: 3,
  smoothing: 0.6,
};

interface ActiveTrack {
  samples: TrackSample[];
  box: Box; // 스무딩된 현재 박스
  missCount: number;
  detectedCount: number;
  scoreSum: number;
  lastDetectedIdx: number; // samples 내에서 마지막 'detected' 위치
}

export function buildTracks(
  perFrame: { t: number; detections: Detection[] }[],
  opts?: Partial<TrackOptions>,
): Track[] {
  const o: TrackOptions = { ...DEFAULTS, ...opts };
  const frames = [...perFrame].sort((a, b) => a.t - b.t);
  const timestamps = frames.map((f) => f.t);
  const cutSet = new Set(o.cuts ?? []);
  const cutsSorted = [...cutSet].sort((a, b) => a - b);

  const active: ActiveTrack[] = [];
  const finished: ActiveTrack[] = [];

  const finalize = (tr: ActiveTrack): void => {
    // 종료 시점의 held 꼬리는 자연스러운 끝 연장이 된다 (최대 holdFrames)
    finished.push(tr);
  };

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    if (!frame) continue;
    const { t, detections } = frame;

    // 장면 전환: 이전 장면의 트랙을 모두 종료한다 (같은 위치라도 다른 사람이다)
    if (cutSet.has(t) && active.length > 0) {
      for (const tr of active) finalize(tr);
      active.length = 0;
    }

    // IoU greedy 매칭: (트랙, 검출) 쌍을 IoU 내림차순으로 소진
    const pairs: { ti: number; di: number; iou: number }[] = [];
    for (let ti = 0; ti < active.length; ti++) {
      const tr = active[ti];
      if (!tr) continue;
      for (let di = 0; di < detections.length; di++) {
        const det = detections[di];
        if (!det) continue;
        const v = iou(tr.box, det.box);
        if (v >= o.iouThreshold) pairs.push({ ti, di, iou: v });
      }
    }
    pairs.sort((a, b) => b.iou - a.iou);

    const usedTrack = new Set<number>();
    const usedDet = new Set<number>();
    for (const p of pairs) {
      if (usedTrack.has(p.ti) || usedDet.has(p.di)) continue;
      usedTrack.add(p.ti);
      usedDet.add(p.di);
      const tr = active[p.ti];
      const det = detections[p.di];
      if (!tr || !det) continue;

      // 공백(miss) 후 재매칭 → held로 채웠던 구간을 선형 보간으로 대체
      if (tr.missCount > 0) {
        const gapLen = tr.missCount;
        const startIdx = tr.samples.length - gapLen;
        const from = tr.samples[startIdx - 1]?.box ?? tr.box;
        for (let k = 0; k < gapLen; k++) {
          const s = tr.samples[startIdx + k];
          if (!s) continue;
          const alpha = (k + 1) / (gapLen + 1);
          s.box = lerpBox(from, det.box, alpha);
          s.source = 'interpolated';
        }
      }

      // EMA 스무딩 — 프레임 단위 떨림 제거
      tr.box = lerpBox(tr.box, det.box, o.smoothing);
      tr.samples.push({ t, box: tr.box, source: 'detected' });
      tr.missCount = 0;
      tr.detectedCount++;
      tr.scoreSum += det.score;
      tr.lastDetectedIdx = tr.samples.length - 1;
    }

    // 매칭 실패한 트랙: hold 또는 종료
    for (let ti = active.length - 1; ti >= 0; ti--) {
      if (usedTrack.has(ti)) continue;
      const tr = active[ti];
      if (!tr) continue;
      tr.missCount++;
      if (tr.missCount <= o.holdFrames) {
        tr.samples.push({ t, box: tr.box, source: 'held' });
      } else {
        finalize(tr);
        active.splice(ti, 1);
      }
    }

    // 매칭되지 않은 검출: 새 트랙 시작
    for (let di = 0; di < detections.length; di++) {
      if (usedDet.has(di)) continue;
      const det = detections[di];
      if (!det) continue;
      active.push({
        samples: [{ t, box: det.box, source: 'detected' }],
        box: det.box,
        missCount: 0,
        detectedCount: 1,
        scoreSum: det.score,
        lastDetectedIdx: 0,
      });
    }
  }
  for (const tr of active) finalize(tr);

  // 폐기 + 시작 연장 + ID 부여
  const out: Track[] = [];
  let seq = 1;
  for (const tr of finished) {
    if (tr.detectedCount < o.minTrackFrames) {
      const first = tr.samples[0];
      if (first) o.onDiscard?.(first.t);
      continue;
    }
    extendStart(tr.samples, timestamps, o.holdFrames, cutsSorted);
    extendEnd(tr.samples, timestamps, o.holdFrames, cutsSorted);
    out.push({
      id: `A${seq++}`,
      samples: tr.samples,
      enabled: true,
      style: null,
      origin: 'auto',
      avgScore: tr.detectedCount > 0 ? tr.scoreSum / tr.detectedCount : 0,
    });
  }
  out.sort((a, b) => (a.samples[0]?.t ?? 0) - (b.samples[0]?.t ?? 0));
  // 정렬 후 ID를 시간순으로 다시 부여
  out.forEach((tr, i) => (tr.id = `A${i + 1}`));
  return out;
}

/** 트랙 시작을 holdFrames만큼 과거로 연장 (첫 박스 복제). 컷 경계는 넘지 않는다. */
function extendStart(samples: TrackSample[], timestamps: number[], holdFrames: number, cuts: number[]): void {
  const first = samples[0];
  if (!first) return;
  // 트랙이 속한 장면의 시작 컷 (컷 프레임 자체는 새 장면의 첫 프레임)
  const sceneStart = latestCutAtOrBefore(cuts, first.t);
  const idx = lowerBound(timestamps, first.t);
  const prepend: TrackSample[] = [];
  for (let k = Math.max(0, idx - holdFrames); k < idx; k++) {
    const t = timestamps[k];
    if (t === undefined) continue;
    if (sceneStart !== null && t < sceneStart) continue;
    prepend.push({ t, box: first.box, source: 'held' });
  }
  samples.unshift(...prepend);
}

/** 트랙 끝 연장 — miss 없이 영상이 끝났거나 held 꼬리가 짧을 때 채운다. 컷 경계는 넘지 않는다. */
function extendEnd(samples: TrackSample[], timestamps: number[], holdFrames: number, cuts: number[]): void {
  const last = samples[samples.length - 1];
  if (!last) return;
  const nextCut = earliestCutAfter(cuts, last.t);
  // 이미 붙어 있는 held 꼬리 길이만큼 차감
  let heldTail = 0;
  for (let i = samples.length - 1; i >= 0 && samples[i]?.source === 'held'; i--) heldTail++;
  const want = holdFrames - heldTail;
  if (want <= 0) return;
  const idx = lowerBound(timestamps, last.t);
  for (let k = idx + 1; k <= Math.min(timestamps.length - 1, idx + want); k++) {
    const t = timestamps[k];
    if (t === undefined) continue;
    if (nextCut !== null && t >= nextCut) break;
    samples.push({ t, box: last.box, source: 'held' });
  }
}

function latestCutAtOrBefore(cuts: number[], t: number): number | null {
  let result: number | null = null;
  for (const c of cuts) {
    if (c <= t) result = c;
    else break;
  }
  return result;
}

function earliestCutAfter(cuts: number[], t: number): number | null {
  for (const c of cuts) {
    if (c > t) return c;
  }
  return null;
}

function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 중복 검출 제거 (greedy NMS) — 타일 병합·YuNet 후처리 공용 */
export function nms<T extends { box: Box; score: number }>(dets: T[], iouThreshold: number): T[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const d of sorted) {
    if (kept.every((k) => iou(k.box, d.box) < iouThreshold)) kept.push(d);
  }
  return kept;
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function lerpBox(a: Box, b: Box, alpha: number): Box {
  return {
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    w: a.w + (b.w - a.w) * alpha,
    h: a.h + (b.h - a.h) * alpha,
  };
}

/** 시각 t에서 트랙의 박스를 샘플 보간으로 구한다. 범위 밖이면 null. */
export function sampleTrackAt(track: Track, t: number): Box | null {
  const s = track.samples;
  if (s.length === 0) return null;
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last) return null;
  if (t < first.t || t > last.t) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((s[mid]?.t ?? Infinity) <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = s[lo];
  const b = s[Math.min(lo + 1, s.length - 1)];
  if (!a || !b) return null;
  if (b.t === a.t) return a.box;
  const alpha = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return lerpBox(a.box, b.box, alpha);
}
