/**
 * 타임라인 + 검증 스트립.
 *
 * 검증 스트립이 이 앱의 시그니처다: 프레임 단위 상태 바.
 * - 자동 검출됨: 채워진 블록 (중성 회색)
 * - 보간/유지됨: 옅은 블록
 * - 검출 0개: 경고 사선 (해저드 스트라이프) — 유일하게 색이 쓰이는 곳
 * - 수동으로 덮음: 하단 굵은 밑줄
 *
 * `N` 키: 다음 사선 구간으로 점프. 사용자는 사선만 순회하면 된다.
 */
import type { AppState } from './state';
import { computeStrip, hazardSegments, nextHazard, nearestIndex, type StripData } from './frameState';
import { trackColor } from './colors';
import { t } from './i18n';

const COLORS = {
  bg: '#1F1F26',
  line: '#32323C',
  detected: '#6E6E78',
  held: '#3E3E48',
  hazard: '#FFD400',
  manual: '#E8E6E1',
  playhead: '#E8E6E1',
  range: 'rgba(232,230,225,0.25)',
};

export class Timeline {
  readonly root: HTMLElement;
  private timelineCanvas: HTMLCanvasElement;
  private stripCanvas: HTMLCanvasElement;
  private state: AppState;
  private strip: StripData | null = null;
  private stripDirty = true;
  private animFrom = 0;
  private animTo = 0;
  private animStart = 0;
  private animating = false;
  private draggingSeek = false;
  private draggingHandle: 'start' | 'end' | null = null;

  onHazardCountChange: ((count: number) => void) | null = null;

  constructor(state: AppState) {
    this.state = state;
    this.root = document.createElement('div');
    this.root.className = 'timeline-stack';
    this.timelineCanvas = document.createElement('canvas');
    this.timelineCanvas.className = 'timeline';
    this.stripCanvas = document.createElement('canvas');
    this.stripCanvas.className = 'strip';
    const hint = document.createElement('div');
    hint.className = 'strip-hint';
    hint.innerHTML = t('stripHint');
    this.root.append(this.timelineCanvas, this.stripCanvas, hint);

    state.on('project', () => {
      this.stripDirty = true;
      this.draw();
    });
    state.on('time', () => this.draw());
    state.on('selection', () => this.draw());

    new ResizeObserver(() => {
      this.resize();
      this.draw();
    }).observe(this.root);

    this.bindPointer();
  }

  private resize(): void {
    const w = this.root.clientWidth || 600;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.timelineCanvas, this.stripCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(c.clientHeight * dpr) || (c === this.timelineCanvas ? 26 : 16) * dpr;
    }
  }

  private ensureStrip(): StripData | null {
    if (!this.state.project || !this.state.frames) return null;
    if (this.stripDirty || !this.strip) {
      this.strip = computeStrip(this.state.project, this.state.frames);
      this.stripDirty = false;
      this.onHazardCountChange?.(hazardSegments(this.strip).length);
    }
    return this.strip;
  }

  hazardCount(): number {
    const strip = this.ensureStrip();
    return strip ? hazardSegments(strip).length : 0;
  }

  /** N 키: 다음 미검증 구간으로 점프 (120ms 플레이헤드 이동, reduced-motion 존중) */
  jumpToNextHazard(): boolean {
    const strip = this.ensureStrip();
    const frames = this.state.frames;
    if (!strip || !frames) return false;
    const curIdx = nearestIndex(frames.timestampsUs, this.state.currentUs);
    const idx = nextHazard(strip, curIdx);
    if (idx === null) return false;
    const targetUs = frames.timestampsUs[idx];
    if (targetUs === undefined) return false;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      this.state.setTime(targetUs);
      return true;
    }
    this.animFrom = this.state.currentUs;
    this.animTo = targetUs;
    this.animStart = performance.now();
    this.animating = true;
    const step = (): void => {
      if (!this.animating) return;
      const p = Math.min(1, (performance.now() - this.animStart) / 120);
      const eased = 1 - (1 - p) * (1 - p);
      this.state.setTime(this.animFrom + (this.animTo - this.animFrom) * eased);
      if (p < 1) requestAnimationFrame(step);
      else this.animating = false;
    };
    requestAnimationFrame(step);
    return true;
  }

  draw(): void {
    this.drawTimeline();
    this.drawStrip();
  }

  private drawTimeline(): void {
    const ctx = this.timelineCanvas.getContext('2d');
    const project = this.state.project;
    if (!ctx || !project) return;
    const W = this.timelineCanvas.width;
    const H = this.timelineCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const dur = project.source.durationUs || 1;

    // 장면 전환(컷) 마커 — 구간 길이를 조정할 때 컷 위치를 보고 맞출 수 있게
    const cuts = this.state.frames?.cutsUs ?? [];
    ctx.fillStyle = COLORS.line;
    for (const c of cuts) {
      const x = (c / dur) * W;
      ctx.fillRect(x - 0.5, 0, 1, H);
      ctx.fillStyle = COLORS.detected;
      ctx.fillRect(x - 0.5, 0, 1, H * 0.3);
      ctx.fillStyle = COLORS.line;
    }

    // 선택 트랙 구간 바 + 양끝 핸들 (트랙 색상, 드래그 중엔 확대·강조)
    const sel = this.state.selectedTrack();
    if (sel && sel.samples.length > 0) {
      const color = trackColor(sel.id);
      const t0 = sel.samples[0]?.t ?? 0;
      const t1 = sel.samples[sel.samples.length - 1]?.t ?? 0;
      const x0 = (t0 / dur) * W;
      const x1 = (t1 / dur) * W;
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = color;
      ctx.fillRect(x0, H * 0.25, Math.max(2, x1 - x0), H * 0.5);
      ctx.globalAlpha = 1;
      const drawHandle = (x: number, active: boolean): void => {
        ctx.fillStyle = color;
        if (active) {
          ctx.fillRect(x - 5, 0, 10, H);
        } else {
          ctx.fillRect(x - 3, H * 0.1, 6, H * 0.8);
        }
      };
      drawHandle(x0, this.draggingHandle === 'start');
      drawHandle(x1, this.draggingHandle === 'end');
    }

    // 플레이헤드
    const px = (this.state.currentUs / dur) * W;
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(px - 1, 0, 2, H);
  }

  private drawStrip(): void {
    const ctx = this.stripCanvas.getContext('2d');
    const project = this.state.project;
    const frames = this.state.frames;
    if (!ctx || !project || !frames) return;
    const strip = this.ensureStrip();
    if (!strip) return;

    const W = this.stripCanvas.width;
    const H = this.stripCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const n = strip.states.length;
    if (n === 0) return;
    const dur = project.source.durationUs || 1;
    const blockH = H * 0.72;

    // 프레임 → 픽셀 열 집계 (프레임 수 > 픽셀 폭 대응)
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * n);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
      let hasHazard = false;
      let hasDetected = false;
      let hasHeld = false;
      let hasManual = false;
      for (let i = i0; i < i1 && i < n; i++) {
        const s = strip.states[i];
        if (s === 'hazard') hasHazard = true;
        else if (s === 'detected') hasDetected = true;
        else if (s === 'held') hasHeld = true;
        if (strip.manual[i]) hasManual = true;
      }
      if (hasHazard) {
        // 해저드 사선: 4px 주기 스트라이프
        ctx.fillStyle = (x >> 2) % 2 === 0 ? COLORS.hazard : '#4A4008';
        ctx.fillRect(x, 0, 1, blockH);
      } else if (hasDetected) {
        ctx.fillStyle = COLORS.detected;
        ctx.fillRect(x, 0, 1, blockH);
      } else if (hasHeld) {
        ctx.fillStyle = COLORS.held;
        ctx.fillRect(x, 0, 1, blockH);
      }
      if (hasManual) {
        ctx.fillStyle = COLORS.manual;
        ctx.fillRect(x, blockH + 2, 1, H - blockH - 2);
      }
    }

    // 짧은 검출 무시됨 마커
    ctx.fillStyle = COLORS.hazard;
    for (const idx of strip.discarded) {
      const t = frames.timestampsUs[idx];
      if (t === undefined) continue;
      const x = (t / dur) * W;
      ctx.fillRect(x - 1, blockH, 2, 2);
    }

    // 플레이헤드
    const px = (this.state.currentUs / dur) * W;
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(px - 1, 0, 2, H);
  }

  // ── 시킹/핸들 드래그 ─────────────────────────────

  private timeAt(e: PointerEvent, canvas: HTMLCanvasElement): number {
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return frac * (this.state.project?.source.durationUs ?? 0);
  }

  /** 핸들 드래그가 컷 근처(8px)면 컷 경계에 스냅 */
  private snapToCut(e: PointerEvent, canvas: HTMLCanvasElement, t: number): number {
    const cuts = this.state.frames?.cutsUs ?? [];
    if (cuts.length === 0) return t;
    const rect = canvas.getBoundingClientRect();
    const dur = this.state.project?.source.durationUs || 1;
    const thresholdUs = (8 / rect.width) * dur;
    let best = t;
    let bestDist = thresholdUs;
    for (const c of cuts) {
      const d = Math.abs(c - t);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  private bindPointer(): void {
    const down = (e: PointerEvent, canvas: HTMLCanvasElement): void => {
      canvas.setPointerCapture(e.pointerId);
      const project = this.state.project;
      if (!project) return;

      // 선택 트랙의 양끝 핸들 히트 테스트 (타임라인만)
      if (canvas === this.timelineCanvas) {
        const sel = this.state.selectedTrack();
        if (sel && sel.samples.length > 0) {
          const rect = canvas.getBoundingClientRect();
          const dur = project.source.durationUs || 1;
          const x = e.clientX - rect.left;
          const x0 = ((sel.samples[0]?.t ?? 0) / dur) * rect.width;
          const x1 = ((sel.samples[sel.samples.length - 1]?.t ?? 0) / dur) * rect.width;
          // 터치 판정 넉넉하게 (14px). 두 핸들이 겹치면 가까운 쪽 우선
          const HIT = 14;
          const d0 = Math.abs(x - x0);
          const d1 = Math.abs(x - x1);
          if (Math.min(d0, d1) < HIT) {
            this.state.pushUndo();
            this.draggingHandle = d0 <= d1 ? 'start' : 'end';
            this.draw();
            return;
          }
        }
      }
      this.draggingSeek = true;
      this.state.setTime(this.timeAt(e, canvas));
    };

    const move = (e: PointerEvent, canvas: HTMLCanvasElement): void => {
      if (this.draggingHandle) {
        const sel = this.state.selectedTrack();
        if (sel) {
          adjustTrackRange(sel, this.draggingHandle, this.snapToCut(e, canvas, this.timeAt(e, canvas)));
          this.state.emit('project');
        }
        return;
      }
      if (this.draggingSeek) this.state.setTime(this.timeAt(e, canvas));
    };

    const up = (): void => {
      this.draggingSeek = false;
      if (this.draggingHandle) {
        this.draggingHandle = null;
        this.draw();
      }
    };

    for (const canvas of [this.timelineCanvas, this.stripCanvas]) {
      canvas.addEventListener('pointerdown', (e) => down(e, canvas));
      canvas.addEventListener('pointermove', (e) => move(e, canvas));
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    }
  }
}

/** 트랙 시작/끝 시각을 드래그로 조정. 경계 밖 샘플은 잘리고 경계에 에지 샘플이 놓인다. */
export function adjustTrackRange(track: import('../types').Track, which: 'start' | 'end', t: number): void {
  const samples = track.samples;
  if (samples.length === 0) return;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return;

  if (which === 'start') {
    const maxT = last.t - 1;
    const nt = Math.max(0, Math.min(maxT, t));
    if (nt < first.t) {
      // 연장: 첫 박스 복제
      samples.unshift({ t: nt, box: first.box, source: track.origin === 'manual' ? 'manual' : 'held' });
    } else {
      // 트림: nt 이전 샘플 제거 후 경계 샘플 삽입
      const keep = samples.filter((s) => s.t > nt);
      const edgeBox = keep[0]?.box ?? last.box;
      track.samples = [{ t: nt, box: edgeBox, source: track.origin === 'manual' ? 'manual' : 'held' }, ...keep];
    }
  } else {
    const minT = first.t + 1;
    const nt = Math.max(minT, t);
    if (nt > last.t) {
      samples.push({ t: nt, box: last.box, source: track.origin === 'manual' ? 'manual' : 'held' });
    } else {
      const keep = samples.filter((s) => s.t < nt);
      const edgeBox = keep[keep.length - 1]?.box ?? first.box;
      track.samples = [...keep, { t: nt, box: edgeBox, source: track.origin === 'manual' ? 'manual' : 'held' }];
    }
  }
}
