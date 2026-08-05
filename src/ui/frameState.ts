/**
 * 검증 스트립의 원천 데이터: 프레임 단위 상태 계산.
 *
 * - detected: 자동 검출됨 (채워진 블록)
 * - held: 보간/유지됨 (옅은 블록)
 * - hazard: 검출 0개 — 경고 사선. 수동 커버가 없으면 하자드 유지.
 *   얼굴이 실제로 없는 구간도 사선이다 — 사용자가 눈으로 확인해야 "확신"이 된다.
 * - manual 커버는 별도 플래그 (하단 굵은 밑줄)
 */
import type { FrameIndex, Project } from '../types';
import { sampleTrackAt } from '../core/track';

export type FrameBaseState = 'detected' | 'held' | 'hazard';

export interface StripData {
  states: FrameBaseState[];
  manual: boolean[];
  /** 폐기된 짧은 검출 프레임 인덱스 */
  discarded: number[];
}

export function computeStrip(project: Project, frames: FrameIndex): StripData {
  const n = frames.timestampsUs.length;
  const states: FrameBaseState[] = new Array(n);
  const manual: boolean[] = new Array(n).fill(false);

  const autoTracks = project.tracks.filter((t) => t.enabled && t.origin === 'auto');
  const manualTracks = project.tracks.filter((t) => t.enabled && t.origin === 'manual');

  for (let i = 0; i < n; i++) {
    const t = frames.timestampsUs[i];
    if (t === undefined) continue;
    const detCount = frames.detectionCounts[i] ?? 0;
    manual[i] = manualTracks.some((tr) => sampleTrackAt(tr, t) !== null);
    if (detCount > 0) {
      states[i] = 'detected';
    } else if (autoTracks.some((tr) => sampleTrackAt(tr, t) !== null)) {
      states[i] = 'held';
    } else if (manual[i]) {
      states[i] = 'held'; // 수동으로 덮인 프레임은 하자드가 아니다
    } else {
      states[i] = 'hazard';
    }
  }

  const discarded: number[] = [];
  for (const t of frames.discardedShortAt) {
    const idx = nearestIndex(frames.timestampsUs, t);
    if (idx >= 0) discarded.push(idx);
  }

  return { states, manual, discarded };
}

/** 하자드 연속 구간 [startIdx, endIdx] 목록 */
export function hazardSegments(strip: StripData): { start: number; end: number }[] {
  const segs: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i < strip.states.length; i++) {
    if (strip.states[i] === 'hazard') {
      if (start < 0) start = i;
    } else if (start >= 0) {
      segs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) segs.push({ start, end: strip.states.length - 1 });
  return segs;
}

/** 현재 프레임 이후의 다음 하자드 구간 시작 (없으면 처음부터 순환) */
export function nextHazard(strip: StripData, fromIdx: number): number | null {
  const segs = hazardSegments(strip);
  if (segs.length === 0) return null;
  for (const seg of segs) {
    if (seg.start > fromIdx) return seg.start;
  }
  return segs[0]?.start ?? null;
}

export function nearestIndex(sorted: number[], v: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < v) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const a = sorted[lo - 1] ?? 0;
    const b = sorted[lo] ?? 0;
    if (Math.abs(v - a) < Math.abs(v - b)) return lo - 1;
  }
  return lo;
}
