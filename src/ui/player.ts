/**
 * 플레이어: 원본 <video> 재생 + 오버레이 캔버스에 레닥션 합성.
 * 미리보기는 인코딩하지 않는다 — 원본 재생 위에 실시간 합성이다.
 *
 * 수동 박스: 빈 곳 드래그 → 새 수동 트랙(기본 1초).
 * 선택된 수동 트랙은 드래그로 이동, 모서리로 크기 조절 — 조작할 때마다
 * 현재 시각에 'manual' 키프레임이 추가되고 사이는 선형 보간된다.
 */
import type { Box, RedactStyle, Track } from '../types';
import { sampleTrackAt } from '../core/track';
import { redactFrame } from '../core/redact';
import type { AppState } from './state';

const HANDLE_PX = 10;
const DEFAULT_MANUAL_DURATION_US = 1_000_000;

type DragMode =
  | { kind: 'create'; startX: number; startY: number; box: Box }
  | { kind: 'move'; track: Track; grabDX: number; grabDY: number }
  | { kind: 'resize'; track: Track; corner: 'nw' | 'ne' | 'sw' | 'se'; anchor: { x: number; y: number } };

export class Player {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: AppState;
  private drag: DragMode | null = null;
  private rafPending = false;
  private videoUrl: string | null = null;

  constructor(state: AppState) {
    this.state = state;
    this.root = document.createElement('div');
    this.root.className = 'player-wrap';
    this.video = document.createElement('video');
    this.video.muted = false;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    this.root.append(this.video, this.overlay);
    const ctx = this.overlay.getContext('2d');
    if (!ctx) throw new Error('overlay 2d context');
    this.ctx = ctx;

    this.bindPointer();

    state.on('project', () => this.requestDraw());
    state.on('selection', () => this.requestDraw());
    state.on('time', () => {
      // 외부(타임라인/N키)에서 시간이 바뀐 경우 비디오를 시킹
      const target = this.state.currentUs / 1e6;
      if (Math.abs(this.video.currentTime - target) > 0.02) {
        this.video.currentTime = target;
      }
      this.requestDraw();
    });

    this.video.addEventListener('seeked', () => this.requestDraw());
    this.video.addEventListener('play', () => {
      this.state.playing = true;
      this.state.emit('playback');
      this.tick();
    });
    this.video.addEventListener('pause', () => {
      this.state.playing = false;
      this.state.emit('playback');
    });
  }

  load(file: File): void {
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = URL.createObjectURL(file);
    this.video.src = this.videoUrl;
    const meta = this.state.project?.source;
    if (meta) {
      this.overlay.width = meta.width;
      this.overlay.height = meta.height;
    }
    this.video.addEventListener(
      'loadedmetadata',
      () => {
        // 브라우저는 회전을 적용한 표시 크기를 보고한다. meta와 어긋나면 표시 크기를 따른다.
        if (this.video.videoWidth && this.overlay.width !== this.video.videoWidth) {
          this.overlay.width = this.video.videoWidth;
          this.overlay.height = this.video.videoHeight;
        }
        this.requestDraw();
      },
      { once: true },
    );
  }

  togglePlay(): void {
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  stepFrame(dir: 1 | -1): void {
    this.video.pause();
    const meta = this.state.project?.source;
    const frameUs = meta && meta.frameCount > 0 ? meta.durationUs / meta.frameCount : 33_366;
    this.state.setTime(this.state.currentUs + dir * frameUs);
  }

  private tick = (): void => {
    if (this.video.paused || this.video.ended) return;
    this.state.currentUs = this.video.currentTime * 1e6;
    this.state.emit('time');
    this.draw();
    requestAnimationFrame(this.tick);
  };

  requestDraw(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.draw();
    });
  }

  private activeBoxes(): { box: Box; style: RedactStyle; track: Track }[] {
    const project = this.state.project;
    if (!project) return [];
    const t = this.state.currentUs;
    const out: { box: Box; style: RedactStyle; track: Track }[] = [];
    for (const track of project.tracks) {
      if (!track.enabled) continue;
      const box = sampleTrackAt(track, t);
      if (box) out.push({ box, style: track.style ?? project.globalStyle, track });
    }
    return out;
  }

  private draw(): void {
    const project = this.state.project;
    if (!project) return;
    const W = this.overlay.width;
    const H = this.overlay.height;
    this.ctx.clearRect(0, 0, W, H);
    if (this.video.readyState < 2) return;

    const boxes = this.activeBoxes();
    // 미리보기 합성: 비디오 요소를 소스로 영역만 처리해 오버레이에 얹는다
    const metaLike = { ...project.source, width: W, height: H };
    redactFrame(
      this.ctx,
      this.video,
      boxes.map(({ box, style }) => ({ box, style })),
      metaLike,
    );

    // 선택된 트랙 외곽선 + 핸들
    const sel = this.state.selectedTrack();
    if (sel) {
      const box = sampleTrackAt(sel, this.state.currentUs);
      if (box) {
        const x = box.x * W;
        const y = box.y * H;
        const w = box.w * W;
        const h = box.h * H;
        this.ctx.strokeStyle = '#E8E6E1';
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([6, 4]);
        this.ctx.strokeRect(x, y, w, h);
        this.ctx.setLineDash([]);
        if (sel.origin === 'manual') {
          this.ctx.fillStyle = '#E8E6E1';
          for (const [cx, cy] of [
            [x, y],
            [x + w, y],
            [x, y + h],
            [x + w, y + h],
          ] as const) {
            this.ctx.fillRect(cx - 3, cy - 3, 6, 6);
          }
        }
      }
    }

    // 생성 중인 드래그 박스
    if (this.drag?.kind === 'create') {
      const b = this.drag.box;
      this.ctx.strokeStyle = '#E8E6E1';
      this.ctx.lineWidth = 1.5;
      this.ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    }
  }

  // ── 포인터 인터랙션 ──────────────────────────────

  private toNorm(e: PointerEvent): { x: number; y: number } {
    const rect = this.overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }

  private bindPointer(): void {
    this.overlay.addEventListener('pointerdown', (e) => {
      const project = this.state.project;
      if (!project) return;
      this.overlay.setPointerCapture(e.pointerId);
      const p = this.toNorm(e);
      const t = this.state.currentUs;
      const rect = this.overlay.getBoundingClientRect();
      const handleNX = HANDLE_PX / rect.width;
      const handleNY = HANDLE_PX / rect.height;

      // 1) 선택된 수동 트랙의 모서리 → resize
      const sel = this.state.selectedTrack();
      if (sel && sel.origin === 'manual') {
        const box = sampleTrackAt(sel, t);
        if (box) {
          const corners = [
            { corner: 'nw' as const, cx: box.x, cy: box.y, ax: box.x + box.w, ay: box.y + box.h },
            { corner: 'ne' as const, cx: box.x + box.w, cy: box.y, ax: box.x, ay: box.y + box.h },
            { corner: 'sw' as const, cx: box.x, cy: box.y + box.h, ax: box.x + box.w, ay: box.y },
            { corner: 'se' as const, cx: box.x + box.w, cy: box.y + box.h, ax: box.x, ay: box.y },
          ];
          for (const c of corners) {
            if (Math.abs(p.x - c.cx) < handleNX && Math.abs(p.y - c.cy) < handleNY) {
              this.state.pushUndo();
              this.drag = { kind: 'resize', track: sel, corner: c.corner, anchor: { x: c.ax, y: c.ay } };
              return;
            }
          }
        }
      }

      // 2) 수동 트랙 내부 → 선택 + move
      for (const track of project.tracks) {
        if (track.origin !== 'manual' || !track.enabled) continue;
        const box = sampleTrackAt(track, t);
        if (box && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) {
          this.state.selectedTrackId = track.id;
          this.state.emit('selection');
          this.state.pushUndo();
          this.drag = { kind: 'move', track, grabDX: p.x - box.x, grabDY: p.y - box.y };
          return;
        }
      }

      // 3) 자동 트랙 내부 → 선택만
      for (const track of project.tracks) {
        if (track.origin !== 'auto' || !track.enabled) continue;
        const box = sampleTrackAt(track, t);
        if (box && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) {
          this.state.selectedTrackId = track.id;
          this.state.emit('selection');
          return;
        }
      }

      // 4) 빈 곳 → 새 수동 박스 생성 시작
      this.drag = { kind: 'create', startX: p.x, startY: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } };
    });

    this.overlay.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = this.toNorm(e);
      const t = this.state.currentUs;

      if (this.drag.kind === 'create') {
        const { startX, startY } = this.drag;
        this.drag.box = {
          x: Math.min(startX, p.x),
          y: Math.min(startY, p.y),
          w: Math.abs(p.x - startX),
          h: Math.abs(p.y - startY),
        };
        this.requestDraw();
      } else if (this.drag.kind === 'move') {
        const box = sampleTrackAt(this.drag.track, t);
        if (!box) return;
        const nb: Box = {
          x: Math.max(0, Math.min(1 - box.w, p.x - this.drag.grabDX)),
          y: Math.max(0, Math.min(1 - box.h, p.y - this.drag.grabDY)),
          w: box.w,
          h: box.h,
        };
        upsertManualSample(this.drag.track, t, nb);
        this.state.emit('project');
      } else {
        const a = this.drag.anchor;
        const nb: Box = {
          x: Math.min(a.x, p.x),
          y: Math.min(a.y, p.y),
          w: Math.abs(p.x - a.x),
          h: Math.abs(p.y - a.y),
        };
        if (nb.w > 0.005 && nb.h > 0.005) {
          upsertManualSample(this.drag.track, t, nb);
          this.state.emit('project');
        }
      }
    });

    const finish = (): void => {
      if (!this.drag) return;
      if (this.drag.kind === 'create') {
        const b = this.drag.box;
        this.drag = null;
        if (b.w > 0.01 && b.h > 0.01) {
          this.createManualTrack(b);
        } else {
          // 클릭만 한 경우: 선택 해제
          this.state.selectedTrackId = null;
          this.state.emit('selection');
        }
        this.requestDraw();
      } else {
        this.drag = null;
      }
    };
    this.overlay.addEventListener('pointerup', finish);
    this.overlay.addEventListener('pointercancel', finish);
  }

  private createManualTrack(box: Box): void {
    const project = this.state.project;
    if (!project) return;
    this.state.pushUndo();
    const t0 = this.state.currentUs;
    const t1 = Math.min(project.source.durationUs, t0 + DEFAULT_MANUAL_DURATION_US);
    const track: Track = {
      id: this.state.nextManualId(),
      samples: [
        { t: t0, box, source: 'manual' },
        { t: Math.max(t1, t0 + 1), box, source: 'manual' },
      ],
      enabled: true,
      style: null,
      origin: 'manual',
    };
    project.tracks.push(track);
    this.state.selectedTrackId = track.id;
    this.state.emit('project');
    this.state.emit('selection');
  }
}

/** 이동/크기 조정 시 해당 시각에 'manual' 키프레임을 추가(또는 갱신)한다. 사이는 선형 보간. */
export function upsertManualSample(track: Track, t: number, box: Box): void {
  const first = track.samples[0];
  const last = track.samples[track.samples.length - 1];
  // 트랙 범위 밖이면 가장 가까운 끝 샘플을 조정
  const clampedT = first && last ? Math.max(first.t, Math.min(last.t, t)) : t;
  const EPS = 1000; // 1ms 이내면 같은 키프레임으로 본다
  const idx = track.samples.findIndex((s) => Math.abs(s.t - clampedT) < EPS);
  if (idx >= 0) {
    const s = track.samples[idx];
    if (s) {
      s.box = box;
      s.source = 'manual';
    }
  } else {
    track.samples.push({ t: clampedT, box, source: 'manual' });
    track.samples.sort((a, b) => a.t - b.t);
  }
}
