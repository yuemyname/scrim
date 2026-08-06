/**
 * 플레이어: 원본 <video> 재생 + 오버레이 캔버스에 레닥션 합성.
 * 미리보기는 인코딩하지 않는다 — 원본 재생 위에 실시간 합성이다.
 *
 * 수동 박스 인터랙션 (모드 없음):
 *   탭 → 박스 선택 / 빈 곳 탭 → 선택 해제
 *   드래그 → 항상 새 수동 트랙 생성 (기존 가림 위에서도 — 겹침 레이어 자동)
 *   단, "선택된" 박스 안에서 드래그하면 이동, 모서리는 크기 조절.
 * 조작할 때마다 현재 시각에 'manual' 키프레임이 추가되고 사이는 선형 보간된다.
 *
 * 확대/축소: 두 손가락 핀치·이동(한 손가락은 편집용으로 남긴다), 휠(데스크톱),
 * 버튼. CSS transform으로 화면만 키우므로 좌표 변환은 그대로 유지된다
 * (모든 히트 테스트가 getBoundingClientRect 기준이라 변환 후 값이 자동 반영).
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
  | { kind: 'create'; startX: number; startY: number; box: Box; hitTrackId: string | null }
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

  // ── 확대/축소 상태 ──
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** 활성 포인터 (두 개면 핀치) */
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number } | null = null;
  private pinchCx: number | null = null;
  private pinchCy: number | null = null;
  onZoomChange: ((zoom: number) => void) | null = null;

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
    this.applyTransform(); // 크기가 바뀌면 팬 범위도 달라진다
  }

  // ── 확대/축소 ────────────────────────────────────
  //
  // transform-origin을 (0,0)으로 두고 translate+scale을 직접 관리한다.
  // 팬 범위는 "확대된 내용이 원래 박스를 항상 덮도록" 클램프한다.

  private applyTransform(): void {
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const maxX = 0;
    const minX = -(this.zoom - 1) * w;
    const maxY = 0;
    const minY = -(this.zoom - 1) * h;
    this.panX = Math.min(maxX, Math.max(minX, this.panX));
    this.panY = Math.min(maxY, Math.max(minY, this.panY));
    this.root.style.transformOrigin = '0 0';
    this.root.style.transform =
      this.zoom === 1 ? '' : `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    // 삭제 버튼은 확대돼도 같은 크기로 보이게 역스케일
    this.deleteBtn.style.transform = this.zoom === 1 ? '' : `scale(${1 / this.zoom})`;
    this.deleteBtn.style.transformOrigin = '0 0';
    this.requestDraw();
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  /** 화면 좌표(clientX/Y)를 고정점으로 배율 변경. 고정점 없으면 중앙 기준 */
  setZoom(next: number, anchorClient?: { x: number; y: number }): void {
    const stage = this.root.parentElement;
    if (!stage) return;
    const target = Math.min(8, Math.max(1, next));
    if (target === this.zoom) return;
    const stageRect = stage.getBoundingClientRect();
    const ax = (anchorClient?.x ?? stageRect.left + stageRect.width / 2) - stageRect.left;
    const ay = (anchorClient?.y ?? stageRect.top + stageRect.height / 2) - stageRect.top;
    // 고정점의 요소-로컬 좌표(변환 전)를 유지하도록 팬을 다시 계산
    const lx = (ax - this.root.offsetLeft - this.panX) / this.zoom;
    const ly = (ay - this.root.offsetTop - this.panY) / this.zoom;
    this.zoom = target;
    this.panX = ax - this.root.offsetLeft - lx * target;
    this.panY = ay - this.root.offsetTop - ly * target;
    this.applyTransform();
    this.onZoomChange?.(this.zoom);
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }

  /** 화면 맞춤으로 복귀 */
  resetZoom(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
    this.onZoomChange?.(this.zoom);
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

  /** 화면 교체 시 호출 — 재생을 멈추고 blob URL·옵저버를 해제한다.
   *  안 하면 이전 미디어가 백그라운드에서 계속 재생/유지될 수 있다. */
  dispose(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    if (this.videoUrl) {
      URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = null;
    }
    this.stageObserver?.disconnect();
    this.stageObserver = null;
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

    // 보더·핸들은 "화면 기준" 두께로 그린다 — 확대해도 굵어지지 않게
    const k = this.canvasPerScreenPx();

    // 모든 박스에 트랙별 색 보더 — 같은 프레임의 여러 박스를 구분할 수 있게.
    // 보더는 눈에 보이는 가림 영역(스타일 확대 적용)을 따라 그린다.
    const sel = this.state.selectedTrack();
    for (const { box, style, track } of boxes) {
      if (track.id === sel?.id) continue; // 선택 트랙은 아래에서 강조 표시
      const vis = scaleBox(box, style.scale);
      this.ctx.strokeStyle = trackColor(track.id);
      this.ctx.lineWidth = 1.5 * k;
      this.ctx.setLineDash([6 * k, 4 * k]);
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
        this.ctx.lineWidth = 2.5 * k;
        this.ctx.strokeRect(x, y, w, h);
        // 자동/수동 구분 없이 선택된 트랙은 편집 가능 — 모서리 핸들 표시
        this.ctx.fillStyle = color;
        const hp = HANDLE_PX * k;
        for (const [cx, cy] of [
          [x, y],
          [x + w, y],
          [x, y + h],
          [x + w, y + h],
        ] as const) {
          this.ctx.fillRect(cx - hp / 2, cy - hp / 2, hp, hp);
        }
      }
    }

    // 생성 중인 드래그 박스 — DESIGN.md §7: 조정 중 = 흰색 점선
    if (this.drag?.kind === 'create') {
      const b = this.drag.box;
      this.ctx.strokeStyle = '#FFFFFF';
      this.ctx.lineWidth = 1.5 * k;
      this.ctx.setLineDash([6 * k, 4 * k]);
      this.ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
      this.ctx.setLineDash([]);
    }
  }

  /** 캔버스 픽셀 / 화면 픽셀 비율 — 확대 배율과 표시 축소를 모두 반영한다 */
  private canvasPerScreenPx(): number {
    const rect = this.overlay.getBoundingClientRect();
    if (rect.width <= 0) return 1;
    return this.overlay.width / rect.width;
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
    // 버튼은 변환된 요소 "안"에 배치되므로 좌표는 변환 전 레이아웃 크기 기준이다
    const w = this.overlay.offsetWidth;
    const h = this.overlay.offsetHeight;
    if (w === 0) return;
    const gap = 6 / this.zoom;
    const btnW = 70 / this.zoom;
    const btnH = 30 / this.zoom;
    const rightPx = Math.min(w - 4, (box.x + box.w) * w + gap);
    const topPx = Math.max(4, box.y * h - btnH);
    this.deleteBtn.style.display = 'block';
    this.deleteBtn.style.left = `${Math.max(4, Math.min(w - btnW, rightPx))}px`;
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

  /** 두 포인터 사이 거리·중점 */
  private pinchGeom(): { dist: number; cx: number; cy: number } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  private bindPointer(): void {
    // 데스크톱: 휠(트랙패드 핀치 포함)로 확대. 페이지 스크롤은 막는다.
    this.overlay.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.002);
        this.setZoom(this.zoom * factor, { x: e.clientX, y: e.clientY });
      },
      { passive: false },
    );

    this.overlay.addEventListener('pointerdown', (e) => {
      const project = this.state.project;
      if (!project) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // 두 번째 손가락 → 핀치 확대/이동 시작. 진행 중이던 편집은 취소한다.
      if (this.pointers.size === 2) {
        const g = this.pinchGeom();
        if (g) {
          this.drag = null;
          this.pinch = { dist: g.dist, zoom: this.zoom };
          this.requestDraw();
        }
        return;
      }
      if (this.pointers.size > 2) return;

      try {
        this.overlay.setPointerCapture(e.pointerId);
      } catch {
        /* 일부 환경에서 캡처가 거부될 수 있다 — 캡처 없이도 동작한다 */
      }
      const p = this.toNorm(e);
      const t = this.state.currentUs;
      const rect = this.overlay.getBoundingClientRect();
      const handleNX = HANDLE_PX / rect.width;
      const handleNY = HANDLE_PX / rect.height;

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

      // 2) "선택된" 트랙 내부 → move. 선택되지 않은 박스 위 드래그는 이동이 아니라
      //    새 박스 생성이다 — 겹침 레이어를 모드 전환 없이 쌓을 수 있게.
      if (sel && this.hitBox(sel, p, t)) {
        const box = sampleTrackAt(sel, t);
        if (box) {
          this.state.pushUndo();
          this.drag = { kind: 'move', track: sel, grabDX: p.x - box.x, grabDY: p.y - box.y };
          return;
        }
      }

      // 3) 그 외 → 생성 드래그 시작. 드래그 없이 탭으로 끝나면 아래 트랙을 선택한다.
      //    (탭 판정용 히트 트랙: 수동 우선, 판정은 눈에 보이는 가림 영역 기준)
      let hitTrackId: string | null = null;
      const ordered = [...project.tracks].sort((a, b) => (a.origin === 'manual' ? -1 : 1) - (b.origin === 'manual' ? -1 : 1));
      for (const track of ordered) {
        if (!track.enabled) continue;
        if (this.hitBox(track, p, t)) {
          hitTrackId = track.id;
          break;
        }
      }
      this.drag = { kind: 'create', startX: p.x, startY: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 }, hitTrackId };
    });

    this.overlay.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // 핀치: 배율은 두 손가락 거리, 이동은 중점 이동량
      if (this.pinch) {
        const g = this.pinchGeom();
        if (!g || g.dist <= 0) return;
        const prevCx = this.pinchCx;
        const prevCy = this.pinchCy;
        this.pinchCx = g.cx;
        this.pinchCy = g.cy;
        if (prevCx !== null && prevCy !== null) {
          this.panX += g.cx - prevCx;
          this.panY += g.cy - prevCy;
        }
        this.setZoom((this.pinch.zoom * g.dist) / this.pinch.dist, { x: g.cx, y: g.cy });
        this.applyTransform();
        return;
      }

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

    const endPointer = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pinch && this.pointers.size < 2) {
        this.pinch = null;
        this.pinchCx = null;
        this.pinchCy = null;
      }
    };

    const finish = (): void => {
      if (!this.drag) return;
      if (this.drag.kind === 'create') {
        const b = this.drag.box;
        const hitTrackId = this.drag.hitTrackId;
        this.drag = null;
        if (b.w > 0.01 && b.h > 0.01) {
          // 실제 드래그 → 아래에 무엇이 있든 새 박스 (겹침 레이어 자동)
          this.createManualTrack(b);
        } else if (hitTrackId) {
          // 탭 → 아래 박스 선택
          this.state.selectedTrackId = hitTrackId;
          this.state.emit('selection');
        } else {
          // 빈 곳 탭 → 선택 해제
          this.state.selectedTrackId = null;
          this.state.emit('selection');
        }
        this.requestDraw();
      } else {
        this.drag = null;
      }
    };
    this.overlay.addEventListener('pointerup', (e) => {
      endPointer(e);
      finish();
    });
    this.overlay.addEventListener('pointercancel', (e) => {
      endPointer(e);
      finish();
    });
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
