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
import { redactFrame, scaleBox } from '../core/redact';
import type { AppState } from './state';
import { trackColor } from './colors';
import { t } from './i18n';

const HANDLE_PX = 10;
const DEFAULT_MANUAL_DURATION_US = 1_000_000;

type DragMode =
  | { kind: 'create'; startX: number; startY: number; box: Box }
  | { kind: 'move'; track: Track; grabDX: number; grabDY: number }
  | { kind: 'resize'; track: Track; corner: 'nw' | 'ne' | 'sw' | 'se'; anchor: { x: number; y: number } };

export class Player {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  private imageEl: HTMLImageElement;
  private imageMode = false;
  private overlay: HTMLCanvasElement;
  private deleteBtn: HTMLButtonElement;
  private ctx: CanvasRenderingContext2D;
  private state: AppState;
  private drag: DragMode | null = null;
  private rafPending = false;
  private videoUrl: string | null = null;
  /** 박스 추가 모드: 기존 트랙 위에서도 항상 새 박스를 그린다 (겹치는 레이어 생성용) */
  addBoxMode = false;
  onAddBoxModeChange: ((on: boolean) => void) | null = null;

  setAddBoxMode(on: boolean): void {
    this.addBoxMode = on;
    this.onAddBoxModeChange?.(on);
  }

  constructor(state: AppState) {
    this.state = state;
    this.root = document.createElement('div');
    this.root.className = 'player-wrap';
    this.video = document.createElement('video');
    this.video.muted = false;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.imageEl = document.createElement('img');
    this.imageEl.style.display = 'none';
    this.imageEl.style.width = '100%';
    this.imageEl.style.height = '100%';
    this.imageEl.style.pointerEvents = 'none';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    // 터치 환경용 삭제 버튼 — 선택된 트랙의 박스 옆에 표시
    this.deleteBtn = document.createElement('button');
    this.deleteBtn.className = 'box-delete';
    this.deleteBtn.textContent = t('boxDelete');
    this.deleteBtn.style.display = 'none';
    this.deleteBtn.addEventListener('click', () => this.deleteSelected());
    this.root.append(this.video, this.imageEl, this.overlay, this.deleteBtn);
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
        this.fitToStage();
        this.requestDraw();
      },
      { once: true },
    );
    // 스테이지 크기 변화에 맞춰 플레이어를 리핏 (세로 영상이 하단 바를 덮지 않게)
    const stage = this.root.parentElement;
    if (stage && !this.stageObserver) {
      this.stageObserver = new ResizeObserver(() => this.fitToStage());
      this.stageObserver.observe(stage);
    }
    this.fitToStage();
  }

  private stageObserver: ResizeObserver | null = null;

  /** 영상 비율을 유지하며 스테이지 안에 꼭 맞게 플레이어 크기를 지정한다 */
  private fitToStage(): void {
    const stage = this.root.parentElement;
    if (!stage) return;
    const pad = 16;
    const aw = stage.clientWidth - pad;
    const ah = stage.clientHeight - pad;
    const vw = this.overlay.width;
    const vh = this.overlay.height;
    if (aw <= 0 || ah <= 0 || vw <= 0 || vh <= 0) return;
    const scale = Math.min(aw / vw, ah / vh);
    this.root.style.width = `${Math.max(1, Math.floor(vw * scale))}px`;
    this.root.style.height = `${Math.max(1, Math.floor(vh * scale))}px`;
  }

  /** 사진 모드: 비디오 대신 이미지를 표시하고 단일 프레임으로 동작한다 */
  loadImage(file: File): void {
    this.imageMode = true;
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = URL.createObjectURL(file);
    this.video.style.display = 'none';
    this.imageEl.style.display = 'block';
    this.imageEl.src = this.videoUrl;
    this.imageEl.addEventListener(
      'load',
      () => {
        this.overlay.width = this.imageEl.naturalWidth;
        this.overlay.height = this.imageEl.naturalHeight;
        this.fitToStage();
        this.requestDraw();
      },
      { once: true },
    );
    const stage = this.root.parentElement;
    if (stage && !this.stageObserver) {
      this.stageObserver = new ResizeObserver(() => this.fitToStage());
      this.stageObserver.observe(stage);
    }
  }

  /** 무거운 인코딩 뒤 Safari가 비디오 디코더를 회수하면 시킹이 멈춘다 —
   *  소스를 다시 로드해 디코더를 재확보하고 위치를 복원한다. */
  refresh(): void {
    const t = this.state.currentUs / 1e6;
    const src = this.video.src;
    if (!src) return;
    this.video.load();
    this.video.addEventListener(
      'loadedmetadata',
      () => {
        this.video.currentTime = t;
        this.requestDraw();
      },
      { once: true },
    );
  }

  togglePlay(): void {
    if (this.imageMode) return;
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  stepFrame(dir: 1 | -1): void {
    if (this.imageMode) return;
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
    const source: CanvasImageSource | null = this.imageMode
      ? this.imageEl.complete && this.imageEl.naturalWidth > 0
        ? this.imageEl
        : null
      : this.video.readyState >= 2
        ? this.video
        : null;
    if (!source) return;

    const boxes = this.activeBoxes();
    // 미리보기 합성: 원본 요소를 소스로 영역만 처리해 오버레이에 얹는다
    const metaLike = { ...project.source, width: W, height: H };
    redactFrame(
      this.ctx,
      source,
      boxes.map(({ box, style }) => ({ box, style })),
      metaLike,
    );

    // 모든 박스에 트랙별 색 보더 — 같은 프레임의 여러 박스를 구분할 수 있게.
    // 보더는 눈에 보이는 가림 영역(스타일 확대 적용)을 따라 그린다.
    const sel = this.state.selectedTrack();
    for (const { box, style, track } of boxes) {
      if (track.id === sel?.id) continue; // 선택 트랙은 아래에서 강조 표시
      const vis = scaleBox(box, style.scale);
      this.ctx.strokeStyle = trackColor(track.id);
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([6, 4]);
      this.ctx.strokeRect(vis.x * W, vis.y * H, vis.w * W, vis.h * H);
      this.ctx.setLineDash([]);
    }

    // 선택된 트랙: 굵은 실선 + 모서리 핸들 + 삭제 버튼
    this.deleteBtn.style.display = 'none';
    if (sel) {
      const box = sampleTrackAt(sel, this.state.currentUs);
      if (box) {
        this.positionDeleteButton(box);
        const color = trackColor(sel.id);
        const x = box.x * W;
        const y = box.y * H;
        const w = box.w * W;
        const h = box.h * H;
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 3;
        this.ctx.strokeRect(x, y, w, h);
        // 자동/수동 구분 없이 선택된 트랙은 편집 가능 — 모서리 핸들 표시
        this.ctx.fillStyle = color;
        for (const [cx, cy] of [
          [x, y],
          [x + w, y],
          [x, y + h],
          [x + w, y + h],
        ] as const) {
          this.ctx.fillRect(cx - 5, cy - 5, 10, 10);
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

  /** 선택된 트랙 삭제 (터치 환경에서 Delete 키 대체) */
  private deleteSelected(): void {
    const sel = this.state.selectedTrack();
    const project = this.state.project;
    if (!sel || !project) return;
    this.state.pushUndo();
    project.tracks = project.tracks.filter((t) => t.id !== sel.id);
    this.state.selectedTrackId = null;
    this.state.emit('selection');
    this.state.emit('project');
  }

  private positionDeleteButton(box: Box): void {
    const rect = this.overlay.getBoundingClientRect();
    if (rect.width === 0) return;
    const rightPx = Math.min(rect.width - 4, (box.x + box.w) * rect.width + 6);
    const topPx = Math.max(4, box.y * rect.height - 30);
    this.deleteBtn.style.display = 'block';
    this.deleteBtn.style.left = `${Math.max(4, Math.min(rect.width - 70, rightPx))}px`;
    this.deleteBtn.style.top = `${topPx}px`;
  }

  // ── 포인터 인터랙션 ──────────────────────────────

  private hitBox(track: Track, p: { x: number; y: number }, t: number): boolean {
    // 눈에 보이는 가림 영역(스타일 확대 적용) 기준으로 판정한다
    const base = sampleTrackAt(track, t);
    if (!base) return false;
    const style = track.style ?? this.state.project?.globalStyle;
    const box = scaleBox(base, style?.scale ?? 1);
    return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
  }

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

      // 박스 추가 모드: 아래에 무엇이 있든 새 박스 생성으로 직행 (겹침 레이어)
      if (this.addBoxMode) {
        this.drag = { kind: 'create', startX: p.x, startY: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } };
        return;
      }

      // 1) 선택된 트랙의 모서리 → resize (자동 트랙도 편집 가능 — 'manual' 키프레임이 얹힌다)
      const sel = this.state.selectedTrack();
      if (sel) {
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

      // 2) 트랙 내부 → 선택 + move (수동 우선, 이어서 자동).
      //    판정은 눈에 보이는 가림 영역(확대 적용) 기준.
      const ordered = [...project.tracks].sort((a, b) => (a.origin === 'manual' ? -1 : 1) - (b.origin === 'manual' ? -1 : 1));
      for (const track of ordered) {
        if (!track.enabled) continue;
        if (this.hitBox(track, p, t)) {
          const box = sampleTrackAt(track, t);
          if (!box) continue;
          this.state.selectedTrackId = track.id;
          this.state.emit('selection');
          this.state.pushUndo();
          this.drag = { kind: 'move', track, grabDX: p.x - box.x, grabDY: p.y - box.y };
          return;
        }
      }

      // 3) 빈 곳 → 새 수동 박스 생성 시작
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
          // 박스가 실제로 만들어지면 추가 모드는 1회로 종료
          if (this.addBoxMode) this.setAddBoxMode(false);
        } else if (!this.addBoxMode) {
          // 클릭만 한 경우: 선택 해제 (추가 모드에서는 모드 유지)
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
    // 새로 그린 수동 박스만 선택 상태가 되도록 기존 선택·체크를 모두 해제한다
    this.state.checkedIds.clear();
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
