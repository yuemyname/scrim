/**
 * scrim 엔트리. 기능 감지 → 랜딩 → 분석 → 리뷰 → 내보내기.
 * 미지원 브라우저에는 처리 UI를 띄우지 않고 안내 화면만 표시한다 (반쪽 폴백 금지).
 */
import { APP_NAME, SUPPORT_URL } from './types';
import { AppState } from './ui/state';
import { Player } from './ui/player';
import { Timeline } from './ui/timeline';
import { Sidebar } from './ui/panels';
import { PipelineClient } from './worker/client';
import { openModal, openPrivacyModal, openProgressModal } from './ui/modal';
import { saveBlob, exportProjectJson, parseProjectJson } from './ui/save';
import { toast } from './ui/toast';
import { timecode } from './ui/format';
import { nearestIndex } from './ui/frameState';
import { verifyAssets } from './core/assets';
import { t, currentLang, setLang } from './ui/i18n';
import { sampleTrackAt } from './core/track';
import { redactFrame } from './core/redact';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

const LONG_VIDEO_WARN_US = 5 * 60 * 1_000_000;

/** 수동 트랙 ID 시퀀스 복원 — 개수가 아니라 최대 번호 기준 (삭제된 번호와 충돌 방지) */
function maxManualSeq(tracks: { id: string; origin: string }[]): number {
  let max = 0;
  for (const t of tracks) {
    const m = /^M(\d+)$/.exec(t.id);
    if (t.origin === 'manual' && m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function featureSupported(): boolean {
  return (
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof Worker !== 'undefined'
  );
}

function renderUnsupported(root: HTMLElement): void {
  root.innerHTML = '';
  const landing = document.createElement('div');
  landing.className = 'landing';
  const box = document.createElement('div');
  box.className = 'dropzone';
  box.style.cursor = 'default';
  box.innerHTML = t('unsupportedBrowser');
  landing.appendChild(box);
  root.append(buildTopbar(null, () => renderUnsupported(root)), landing, buildPrivacyFooter());
}

function buildTopbar(onOpen: (() => void) | null, onLangChange?: () => void): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = APP_NAME;
  bar.appendChild(brand);

  if (onLangChange) {
    const langBtn = document.createElement('button');
    langBtn.className = 'lang-toggle';
    langBtn.textContent = currentLang() === 'ko' ? 'EN' : '한국어';
    langBtn.title = currentLang() === 'ko' ? 'Switch to English' : '한국어로 전환';
    langBtn.addEventListener('click', () => {
      setLang(currentLang() === 'ko' ? 'en' : 'ko');
      onLangChange();
    });
    bar.appendChild(langBtn);
  }

  // 후원 버튼 — SUPPORT_URL이 설정된 경우에만 표시. 링크 이동만 하며
  // 앱의 어떤 데이터도 함께 보내지 않는다.
  if (SUPPORT_URL) {
    const supportBtn = document.createElement('button');
    // '☕ coffee' — 이모지는 별도 span(.emoji)으로 분리해야 컬러로 렌더링된다.
    // 버튼 기본 폰트가 모노스페이스라 그냥 넣으면 흑백 글리프가 잡힌다.
    const [emojiPart, ...labelParts] = t('support').split(' ');
    const emojiEl = document.createElement('span');
    emojiEl.className = 'emoji';
    emojiEl.textContent = `${emojiPart ?? ''}️`; // VS16: 이모지 프레젠테이션 요청
    const labelEl = document.createElement('span');
    labelEl.textContent = labelParts.join(' ');
    supportBtn.append(emojiEl, labelEl);
    supportBtn.style.gap = '6px';
    supportBtn.title = t('supportTip');
    supportBtn.addEventListener('click', () => window.open(SUPPORT_URL, '_blank', 'noopener'));
    bar.appendChild(supportBtn);
  }

  if (onOpen) {
    const openBtn = document.createElement('button');
    openBtn.textContent = t('open');
    openBtn.addEventListener('click', onOpen);
    bar.appendChild(openBtn);
  }
  return bar;
}

function buildPrivacyFooter(): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'privacy-footer';
  const a = document.createElement('a');
  a.textContent = '이 영상은 브라우저 밖으로 나가지 않습니다';
  a.addEventListener('click', openPrivacyModal);
  footer.appendChild(a);
  return footer;
}

// ────────────────────────────────────────────────────────

class App {
  private state = new AppState();
  private client = new PipelineClient();
  private root: HTMLElement;
  private fileInput: HTMLInputElement;
  private minConfidence = 0.35;
  private rendering = false;
  private player: Player | null = null;
  private timeline: Timeline | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'video/mp4,video/quicktime,image/*,.mp4,.mov,.jpg,.jpeg,.png,.webp,.heic,.heif';
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      if (f) void this.openFile(f);
      this.fileInput.value = '';
    });
    document.body.appendChild(this.fileInput);

    window.addEventListener('beforeunload', (e) => {
      // 렌더 중 탭 새로고침은 복구하지 않는다 — 시작 전 경고가 전부다
      if (this.rendering) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    this.renderLanding();
  }

  private renderLanding(): void {
    this.root.innerHTML = '';
    const landing = document.createElement('div');
    landing.className = 'landing';

    const drop = document.createElement('div');
    drop.className = 'dropzone';
    drop.innerHTML = `${t('dropLine1')}<br />${t('dropLine2')}`;
    drop.addEventListener('click', () => this.fileInput.click());
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.openFile(f);
    });

    const options = document.createElement('div');
    options.className = 'options';
    const senseLabel = document.createElement('span');
    senseLabel.textContent = t('sensitivity');
    const senseSelect = document.createElement('select');
    for (const [v, text] of [
      ['0.35', t('senseSensitive')],
      ['0.5', t('senseStandard')],
      ['0.65', t('senseConservative')],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = text;
      senseSelect.appendChild(opt);
    }
    senseSelect.value = String(this.minConfidence);
    senseSelect.addEventListener('change', () => (this.minConfidence = Number(senseSelect.value)));

    options.append(senseLabel, senseSelect);

    landing.append(drop, options);
    this.root.append(
      buildTopbar(
        () => this.fileInput.click(),
        () => this.rerenderCurrent(),
      ),
      landing,
      buildPrivacyFooter(),
    );
  }

  /** 언어 전환 후 현재 화면을 다시 그린다 (리뷰 상태·재생 위치 유지) */
  private rerenderCurrent(): void {
    if (this.state.phase === 'review' && this.state.project) {
      const keepUs = this.state.currentUs;
      this.renderReview();
      this.state.setTime(keepUs);
    } else {
      this.renderLanding();
    }
  }

  private async openFile(file: File): Promise<void> {
    if (!(await verifyAssets())) {
      toast(t('modelLoadFail'));
      return;
    }

    const progress = openProgressModal(t('analyzing'), () => this.client.cancel());
    let lastProgressAt = performance.now();
    const visHandler = (): void => {
      if (document.visibilityState === 'visible' && performance.now() - lastProgressAt > 15_000) {
        toast(t('bgSlow'));
      }
    };
    document.addEventListener('visibilitychange', visHandler);

    try {
      const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
      const { project, frames } = isImage
        ? await this.client.analyzeImage(file, this.minConfidence, (p) => {
            lastProgressAt = performance.now();
            progress.update(p);
          })
        : await this.client.analyze(file, this.minConfidence, (p) => {
            lastProgressAt = performance.now();
            progress.update(p);
          });
      this.state.resetForNewMedia();
      this.state.isImage = isImage;
      this.state.file = file;
      this.state.project = project;
      this.state.frames = frames;
      this.state.currentUs = 0;
      this.state.phase = 'review';
      this.state.manualSeq = maxManualSeq(project.tracks);
      this.exportChoice = 'unset'; // 해상도 선택은 미디어별 — 이전 선택을 넘기지 않는다

      if (project.source.durationUs > LONG_VIDEO_WARN_US) {
        toast(t('longVideoWarn'));
      }
      this.renderReview();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        toast(t('analysisCancelled'));
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        openModal((modal, close) => {
          const h = document.createElement('h3');
          h.textContent = t('cannotOpen');
          const p = document.createElement('p');
          p.textContent = msg;
          p.style.whiteSpace = 'pre-wrap';
          p.style.wordBreak = 'break-all';
          p.className = 'mono';
          p.style.fontSize = '11px';
          modal.append(h, p);
          const actions = document.createElement('div');
          actions.className = 'actions';
          const ok = document.createElement('button');
          ok.className = 'primary';
          ok.textContent = t('ok');
          ok.addEventListener('click', close);
          actions.appendChild(ok);
          modal.appendChild(actions);
        });
      }
    } finally {
      document.removeEventListener('visibilitychange', visHandler);
      progress.close();
    }
  }

  private renderReview(): void {
    const state = this.state;
    const project = state.project;
    const file = state.file;
    if (!project || !file) return;

    // 이전 화면 정리: 리스너·이전 미디어 재생·blob URL이 남지 않게
    state.clearListeners();
    this.player?.dispose();

    this.root.innerHTML = '';

    // 상단
    const topbar = buildTopbar(
      () => this.fileInput.click(),
      () => this.rerenderCurrent(),
    );

    // 프로젝트 저장/불러오기
    const projBtns = document.createElement('div');
    projBtns.style.display = 'flex';
    projBtns.style.gap = '8px';
    const saveProj = document.createElement('button');
    saveProj.textContent = t('saveWork');
    saveProj.title = t('saveWorkTip');
    saveProj.addEventListener('click', () => {
      void saveBlob(
        exportProjectJson(project, state.frames, file.size),
        `${file.name.replace(/\.[^.]+$/, '')}.scrim.json`,
        'application/json',
        '.json',
      ).then((ok) => ok && toast(t('workSaved')));
    });
    const loadProj = document.createElement('button');
    loadProj.textContent = t('loadWork');
    loadProj.title = t('loadWorkTip');
    const projInput = document.createElement('input');
    projInput.type = 'file';
    projInput.accept = 'application/json,.json';
    projInput.style.display = 'none';
    projInput.addEventListener('change', async () => {
      const f = projInput.files?.[0];
      projInput.value = '';
      if (!f) return;
      const result = parseProjectJson(await f.text(), {
        fileName: project.source.fileName,
        durationUs: project.source.durationUs,
      });
      if (!result.ok || !result.project) {
        toast(result.reason ?? t('loadFailed'));
        return;
      }
      state.pushUndo();
      project.tracks = result.project.tracks;
      project.globalStyle = result.project.globalStyle;
      state.manualSeq = maxManualSeq(project.tracks);
      state.emit('project');
      toast(t('workLoaded'));
    });
    loadProj.addEventListener('click', () => projInput.click());
    projBtns.append(saveProj, loadProj, projInput);
    topbar.insertBefore(projBtns, topbar.lastElementChild);

    // 중앙: 플레이어 + 사이드바
    const workspace = document.createElement('div');
    workspace.className = 'workspace';
    const stage = document.createElement('div');
    stage.className = 'stage';
    const player = new Player(state);
    this.player = player;
    stage.appendChild(player.root);
    const sidebar = new Sidebar(state);
    workspace.append(stage, sidebar.root);

    // 하단: 트랜스포트 + 타임라인 + 검증 스트립
    const bottombar = document.createElement('div');
    bottombar.className = 'bottombar';

    const transport = document.createElement('div');
    transport.className = 'transport';

    const stepBack = document.createElement('button');
    stepBack.textContent = '◀';
    stepBack.title = t('prevFrame');
    stepBack.addEventListener('click', () => player.stepFrame(-1));
    const playBtn = document.createElement('button');
    playBtn.textContent = t('play');
    playBtn.addEventListener('click', () => player.togglePlay());
    const stepFwd = document.createElement('button');
    stepFwd.textContent = '▶';
    stepFwd.title = t('nextFrame');
    stepFwd.addEventListener('click', () => player.stepFrame(1));

    const time = document.createElement('span');
    time.className = 'time mono';
    const updateTime = (): void => {
      time.innerHTML = `<b>${timecode(state.currentUs)}</b> / ${timecode(project.source.durationUs)}`;
    };
    updateTime();
    state.on('time', updateTime);
    state.on('playback', () => {
      playBtn.textContent = state.playing ? t('pause') : t('play');
    });

    const undoBtn = document.createElement('button');
    undoBtn.textContent = t('undo');
    undoBtn.title = 'Cmd/Ctrl+Z';
    undoBtn.addEventListener('click', () => {
      if (state.undo()) toast(t('undone'));
      else toast(t('nothingToUndo'));
    });

    const redoBtn = document.createElement('button');
    redoBtn.textContent = t('redo');
    redoBtn.title = 'Cmd/Ctrl+Shift+Z';
    redoBtn.addEventListener('click', () => {
      if (state.redo()) toast(t('redone'));
      else toast(t('nothingToRedo'));
    });

    // 확대/축소 — 영상·사진 공통. 배율 칩을 누르면 화면 맞춤으로 복귀
    const zoomOut = document.createElement('button');
    zoomOut.textContent = '−';
    zoomOut.title = t('zoomOut');
    zoomOut.addEventListener('click', () => player.zoomBy(1 / 1.4));
    const zoomChip = document.createElement('button');
    zoomChip.className = 'lcd zoom-chip mono';
    zoomChip.textContent = '100%';
    zoomChip.title = t('zoomTip');
    zoomChip.addEventListener('click', () => player.resetZoom());
    const zoomIn = document.createElement('button');
    zoomIn.textContent = '+';
    zoomIn.title = t('zoomIn');
    zoomIn.addEventListener('click', () => player.zoomBy(1.4));
    player.onZoomChange = (z) => {
      zoomChip.textContent = `${Math.round(z * 100)}%`;
      zoomChip.classList.toggle('on', z !== 1);
    };

    const cutBtn = document.createElement('button');
    cutBtn.textContent = t('cutMark');
    cutBtn.title = t('cutTip');
    cutBtn.addEventListener('click', () => this.toggleCut());

    const trackBtn = document.createElement('button');
    trackBtn.textContent = t('trackFace');
    trackBtn.title = t('trackFaceTip');
    trackBtn.addEventListener('click', () => void this.trackSelected());

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const hazardCount = document.createElement('span');
    hazardCount.className = 'hazard-count mono';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'primary';
    exportBtn.textContent = t('export');
    exportBtn.addEventListener('click', () => void this.exportVideo());

    // 내보내기는 상단바 우측, '영상·사진 열기' 오른쪽에 배치
    const topRight = document.createElement('div');
    topRight.className = 'topbar-right';
    const openBtnEl = topbar.lastElementChild;
    if (openBtnEl) topRight.appendChild(openBtnEl);
    topRight.append(hazardCount, exportBtn);
    topbar.appendChild(topRight);

    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'zoom-group';
    zoomGroup.append(zoomOut, zoomChip, zoomIn);

    if (state.isImage) {
      transport.append(undoBtn, redoBtn, zoomGroup, spacer);
    } else {
      transport.append(stepBack, playBtn, stepFwd, time, undoBtn, redoBtn, trackBtn, cutBtn, zoomGroup, spacer);
    }

    const timeline = new Timeline(state);
    this.timeline = timeline;
    timeline.onHazardCountChange = (count) => {
      if (count > 0) {
        hazardCount.classList.remove('clear');
        hazardCount.textContent = t('hazardCount', { n: count });
      } else {
        hazardCount.classList.add('clear');
        hazardCount.textContent = t('allVerified');
      }
    };

    bottombar.append(transport);
    if (!state.isImage) bottombar.append(timeline.root);

    this.root.append(topbar, workspace, bottombar, buildPrivacyFooter());

    if (state.isImage) player.loadImage(file);
    else player.load(file);
    timeline.draw();
    state.emit('project');

    this.bindKeyboard();
  }

  private keyboardBound = false;
  /** 한 번만 바인딩하되, 항상 "현재" Player/Timeline을 참조한다 —
   *  인스턴스를 캡처하면 새 미디어를 연 뒤 이전(화면에서 사라진) 영상이 조작된다 */
  private bindKeyboard(): void {
    if (this.keyboardBound) return;
    this.keyboardBound = true;
    window.addEventListener('keydown', (e) => {
      if (this.state.phase !== 'review') return;
      const player = this.player;
      const timeline = this.timeline;
      if (!player || !timeline) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

      if (e.key === ' ') {
        e.preventDefault();
        player.togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        player.stepFrame(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        player.stepFrame(1);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (!timeline.jumpToNextHazard()) toast(t('noHazard'));
      } else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.toggleCut();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const project = this.state.project;
        const checked = this.state.checkedTracks();
        const sel = this.state.selectedTrack();
        if (project && (checked.length > 0 || sel)) {
          e.preventDefault();
          this.state.pushUndo();
          const ids = new Set(checked.length > 0 ? checked.map((t) => t.id) : [sel!.id]);
          project.tracks = project.tracks.filter((t) => !ids.has(t.id));
          this.state.checkedIds.clear();
          if (this.state.selectedTrackId && ids.has(this.state.selectedTrackId)) this.state.selectedTrackId = null;
          this.state.emit('selection');
          this.state.emit('project');
          toast(t('deletedTracks', { n: ids.size }));
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        if (this.state.redo()) toast(t('redone'));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (this.state.undo()) toast(t('undone'));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        if (this.state.redo()) toast(t('redone'));
      }
    });
  }

  /** 현재 위치에 컷 마커 추가/삭제 (가장 가까운 프레임에 스냅) */
  private toggleCut(): void {
    const state = this.state;
    const frames = state.frames;
    const project = state.project;
    if (!frames || !project || frames.timestampsUs.length === 0) return;
    frames.cutsUs ??= [];
    const idx = nearestIndex(frames.timestampsUs, state.currentUs);
    const ts = frames.timestampsUs[idx];
    if (ts === undefined) return;
    const frameUs = project.source.durationUs / Math.max(1, project.source.frameCount);
    const existing = frames.cutsUs.findIndex((c) => Math.abs(c - ts) <= frameUs);
    if (existing >= 0) {
      frames.cutsUs.splice(existing, 1);
      toast(t('cutRemoved'));
    } else {
      frames.cutsUs.push(ts);
      frames.cutsUs.sort((a, b) => a - b);
      toast(t('cutAdded'));
    }
    state.emit('project');
  }

  private trackingBusy = false;

  /** 선택한 수동 박스의 구간을 워커에서 추적해 샘플로 치환한다 */
  private async trackSelected(): Promise<void> {
    const state = this.state;
    const project = state.project;
    const file = state.file;
    if (!project || !file || state.isImage || this.rendering || this.trackingBusy) return;

    const sel = state.selectedTrack();
    if (!sel || sel.origin !== 'manual') {
      toast(t('trackNeedManual'));
      return;
    }
    const first = sel.samples[0];
    const last = sel.samples[sel.samples.length - 1];
    if (!first || !last || last.t <= first.t) {
      toast(t('trackNeedManual'));
      return;
    }
    const initBox = sampleTrackAt(sel, first.t) ?? first.box;

    this.trackingBusy = true;
    const progress = openProgressModal(t('tracking'), () => this.client.cancel());
    try {
      const samples = await this.client.trackRegion(
        file,
        first.t,
        last.t,
        initBox,
        this.minConfidence,
        (p) => progress.update(p),
      );
      if (samples.length < 2) {
        toast(t('trackNoFrames'));
        return;
      }
      state.pushUndo();
      sel.samples = samples;
      state.emit('project');
      const found = samples.filter((s) => s.source === 'detected').length;
      toast(t('trackDone', { n: found }));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        toast(t('trackCancelled'));
      } else {
        toast(t('trackFail', { msg: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      this.trackingBusy = false;
      progress.close();
    }
  }

  private exportChoice: number | null | 'unset' = 'unset';

  /** 내보내기 해상도 선택 모달 → 선택 시 렌더 시작 */
  private exportVideo(): void {
    const project = this.state.project;
    if (!project || this.rendering) return;
    if (this.state.isImage) {
      void this.exportImage();
      return;
    }
    const { width, height } = project.source;
    const maxSide = Math.max(width, height);

    const dims = (cap: number | null): string => {
      const s = cap ? Math.min(1, cap / maxSide) : 1;
      const even = (v: number): number => Math.max(2, Math.round(v * s)) & ~1;
      return `${even(width)}×${even(height)}`;
    };

    const options: { label: string; value: number | null }[] = [];
    options.push({ label: `${t('original')} — ${dims(null)}`, value: null });
    if (maxSide > 2560) options.push({ label: `1440p — ${dims(2560)}`, value: 2560 });
    if (maxSide > 1920) options.push({ label: `1080p — ${dims(1920)}`, value: 1920 });
    if (maxSide > 1280) options.push({ label: `720p — ${dims(1280)}`, value: 1280 });

    // 기본값: 4K 초과 소스는 1080p (완주 안정성), 그 외 원본
    const defaultValue = this.exportChoice !== 'unset' ? this.exportChoice : maxSide > 2160 ? 1920 : null;

    openModal((modal, close) => {
      const h = document.createElement('h3');
      h.textContent = t('export');
      const p = document.createElement('p');
      p.textContent = t('resolution');
      const select = document.createElement('select');
      select.style.width = '100%';
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value === null ? 'original' : String(opt.value);
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.value = defaultValue === null ? 'original' : String(defaultValue);

      const warn = document.createElement('p');
      const updateWarn = (): void => {
        const original = select.value === 'original';
        warn.textContent =
          original && maxSide > 2160 ? t('warn4k') : '';
      };
      select.addEventListener('change', updateWarn);
      updateWarn();

      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancel = document.createElement('button');
      cancel.textContent = t('cancel');
      cancel.addEventListener('click', close);
      const go = document.createElement('button');
      go.className = 'primary';
      go.textContent = t('export');
      go.addEventListener('click', () => {
        const value = select.value === 'original' ? null : Number(select.value);
        this.exportChoice = value;
        close();
        void this.runRender(value);
      });
      actions.append(cancel, go);
      modal.append(h, p, select, warn, actions);
    });
  }

  /** 사진 내보내기 — 단일 프레임이라 메인 스레드에서 즉시 처리한다 */
  private async exportImage(): Promise<void> {
    const state = this.state;
    const project = state.project;
    const file = state.file;
    if (!project || !file) return;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const boxes = [];
      for (const track of project.tracks) {
        if (!track.enabled) continue;
        const box = sampleTrackAt(track, 0);
        if (box) boxes.push({ box, style: track.style ?? project.globalStyle });
      }
      const meta = { ...project.source, width: canvas.width, height: canvas.height };
      if (boxes.length > 0) redactFrame(ctx, null, boxes, meta);
      const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
      const blob = await canvas.convertToBlob(
        isPng ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 },
      );
      const outName = `${file.name.replace(/\.[^.]+$/, '')}_scrim.${isPng ? 'png' : 'jpg'}`;
      const saved = await saveBlob(blob, outName, blob.type, isPng ? '.png' : '.jpg');
      if (saved) toast(t('exported'));
    } catch (e) {
      toast(t('exportFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }

  private async runRender(maxLongSide: number | null): Promise<void> {
    const state = this.state;
    const project = state.project;
    const file = state.file;
    if (!project || !file || this.rendering) return;

    this.rendering = true;
    state.phase = 'rendering';
    const progress = openProgressModal(t('exporting'), () => this.client.cancel());
    try {
      const blob = await this.client.render(file, project, maxLongSide, (p) => progress.update(p));
      progress.close();
      const outName = `${file.name.replace(/\.[^.]+$/, '')}_scrim.mp4`;
      const saved = await saveBlob(blob, outName, 'video/mp4', '.mp4');
      if (saved) toast(t('exported'));
    } catch (e) {
      progress.close();
      if (e instanceof DOMException && e.name === 'AbortError') {
        toast(t('exportCancelled'));
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        openModal((modal, close) => {
          const h = document.createElement('h3');
          h.textContent = t('exportFailedTitle');
          const p = document.createElement('p');
          p.textContent = msg;
          p.style.whiteSpace = 'pre-wrap';
          p.style.wordBreak = 'break-all';
          p.className = 'mono';
          p.style.fontSize = '11px';
          const actions = document.createElement('div');
          actions.className = 'actions';
          const ok = document.createElement('button');
          ok.className = 'primary';
          ok.textContent = t('ok');
          ok.addEventListener('click', close);
          actions.appendChild(ok);
          modal.append(h, p, actions);
        });
      }
    } finally {
      this.rendering = false;
      state.phase = 'review';
      // 무거운 인코딩 뒤 비디오 디코더가 회수돼 시킹이 멈추는 것 방지
      this.player?.refresh();
    }
  }
}

// ── 부트 ─────────────────────────────────────────────
if (!featureSupported()) {
  renderUnsupported(app);
} else {
  new App(app);
}

// PWA 오프라인 지원: 같은 오리진 자산만 캐시하는 서비스 워커 (public/sw.js).
// 네트워크로 데이터를 보내지 않는다 — 자산 캐시·재검증뿐이다.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // updateViaCache: 'none' — sw.js 자체를 HTTP 캐시에서 읽지 않는다.
  // 이게 없으면 배포해도 브라우저가 옛 sw.js를 붙들고 있어 갱신이 늦어진다.
  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .catch(() => {
      /* SW 실패는 앱 동작에 영향 없음 (오프라인 지원만 빠진다) */
    });
}
