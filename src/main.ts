/**
 * scrim 엔트리. 기능 감지 → 랜딩 → 분석 → 리뷰 → 내보내기.
 * 미지원 브라우저에는 처리 UI를 띄우지 않고 안내 화면만 표시한다 (반쪽 폴백 금지).
 */
import { APP_NAME } from './types';
import { AppState } from './ui/state';
import { Player } from './ui/player';
import { Timeline } from './ui/timeline';
import { Sidebar } from './ui/panels';
import { PipelineClient } from './worker/client';
import { openModal, openPrivacyModal, openProgressModal } from './ui/modal';
import { saveBlob, exportProjectJson, parseProjectJson } from './ui/save';
import { toast } from './ui/toast';
import { timecode } from './ui/format';
import { verifyAssets } from './core/assets';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

const LONG_VIDEO_WARN_US = 5 * 60 * 1_000_000;

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
  box.innerHTML =
    '이 브라우저는 영상 처리 기능(WebCodecs)을 지원하지 않습니다.<br />' +
    'Safari 16.4+, Chrome 94+, Firefox 130+ 에서 열어 주세요.';
  landing.appendChild(box);
  root.append(buildTopbar(null), landing, buildPrivacyFooter());
}

function buildTopbar(onOpen: (() => void) | null): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = APP_NAME;
  bar.appendChild(brand);
  if (onOpen) {
    const openBtn = document.createElement('button');
    openBtn.textContent = '영상 열기';
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
  private longSide = 512;
  private rendering = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'video/mp4,video/quicktime,.mp4,.mov';
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
    drop.innerHTML = '영상을 끌어다 놓으세요.<br />파일은 이 브라우저를 벗어나지 않습니다.';
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
    const label = document.createElement('span');
    label.textContent = '검출 정밀도';
    const select = document.createElement('select');
    for (const [v, text] of [
      ['512', '표준 — 빠름'],
      ['768', '정밀 — 군중·원거리 얼굴'],
      ['1024', '최대 — 가장 느림'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.value = String(this.longSide);
    select.addEventListener('change', () => (this.longSide = Number(select.value)));
    options.append(label, select);

    landing.append(drop, options);
    this.root.append(buildTopbar(() => this.fileInput.click()), landing, buildPrivacyFooter());
  }

  private async openFile(file: File): Promise<void> {
    if (!(await verifyAssets())) {
      toast('얼굴 검출 모델을 불러올 수 없습니다. 페이지를 새로 고침해 주세요.');
      return;
    }

    const progress = openProgressModal('분석 중', () => this.client.cancel());
    let lastProgressAt = performance.now();
    const visHandler = (): void => {
      if (document.visibilityState === 'visible' && performance.now() - lastProgressAt > 15_000) {
        toast('백그라운드에서 처리가 느려졌을 수 있습니다. 탭을 열어 둔 채 기다려 주세요.');
      }
    };
    document.addEventListener('visibilitychange', visHandler);

    try {
      const { project, frames } = await this.client.analyze(file, this.longSide, (p) => {
        lastProgressAt = performance.now();
        progress.update(p);
      });
      this.state.file = file;
      this.state.project = project;
      this.state.frames = frames;
      this.state.currentUs = 0;
      this.state.phase = 'review';

      if (project.source.durationUs > LONG_VIDEO_WARN_US) {
        toast('5분이 넘는 영상입니다. 처리 시간이 길어질 수 있으니 구간을 나눠 작업하는 것을 권합니다.');
      }
      this.renderReview();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        toast('분석을 취소했습니다.');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        openModal((modal, close) => {
          modal.innerHTML = `<h3>영상을 열 수 없습니다</h3><p>${msg}</p>`;
          const actions = document.createElement('div');
          actions.className = 'actions';
          const ok = document.createElement('button');
          ok.className = 'primary';
          ok.textContent = '확인';
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

    this.root.innerHTML = '';

    // 상단
    const topbar = buildTopbar(() => this.fileInput.click());

    // 프로젝트 저장/불러오기
    const projBtns = document.createElement('div');
    projBtns.style.display = 'flex';
    projBtns.style.gap = '8px';
    const saveProj = document.createElement('button');
    saveProj.textContent = '프로젝트 저장';
    saveProj.addEventListener('click', () => {
      void saveBlob(
        exportProjectJson(project),
        `${file.name.replace(/\.[^.]+$/, '')}.scrim.json`,
        'application/json',
        '.json',
      ).then((ok) => ok && toast('프로젝트를 저장했습니다'));
    });
    const loadProj = document.createElement('button');
    loadProj.textContent = '프로젝트 불러오기';
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
        toast(result.reason ?? '불러오기에 실패했습니다.');
        return;
      }
      state.pushUndo();
      project.tracks = result.project.tracks;
      project.globalStyle = result.project.globalStyle;
      state.manualSeq = project.tracks.filter((t) => t.origin === 'manual').length;
      state.emit('project');
      toast('프로젝트를 불러왔습니다');
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
    stepBack.title = '이전 프레임 (←)';
    stepBack.addEventListener('click', () => player.stepFrame(-1));
    const playBtn = document.createElement('button');
    playBtn.textContent = '재생';
    playBtn.addEventListener('click', () => player.togglePlay());
    const stepFwd = document.createElement('button');
    stepFwd.textContent = '▶';
    stepFwd.title = '다음 프레임 (→)';
    stepFwd.addEventListener('click', () => player.stepFrame(1));

    const time = document.createElement('span');
    time.className = 'time mono';
    const updateTime = (): void => {
      time.innerHTML = `<b>${timecode(state.currentUs)}</b> / ${timecode(project.source.durationUs)}`;
    };
    updateTime();
    state.on('time', updateTime);
    state.on('playback', () => {
      playBtn.textContent = state.playing ? '일시정지' : '재생';
    });

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const hazardCount = document.createElement('span');
    hazardCount.className = 'hazard-count mono';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'primary';
    exportBtn.textContent = '내보내기';
    exportBtn.addEventListener('click', () => void this.exportVideo());

    transport.append(stepBack, playBtn, stepFwd, time, spacer, hazardCount, exportBtn);

    const timeline = new Timeline(state);
    timeline.onHazardCountChange = (count) => {
      if (count > 0) {
        hazardCount.classList.remove('clear');
        hazardCount.textContent = `미검증 구간 ${count}개`;
      } else {
        hazardCount.classList.add('clear');
        hazardCount.textContent = '모든 구간 확인됨';
      }
    };

    bottombar.append(transport, timeline.root);

    // 오디오 경고 배너
    if (!project.source.hasAudio) {
      const banner = document.createElement('div');
      banner.className = 'warn-banner';
      banner.textContent = '오디오가 없거나 형식이 지원되지 않아 영상만 내보내집니다.';
      bottombar.prepend(banner);
    }

    this.root.append(topbar, workspace, bottombar, buildPrivacyFooter());

    player.load(file);
    timeline.draw();
    state.emit('project');

    this.bindKeyboard(player, timeline);
  }

  private keyboardBound = false;
  private bindKeyboard(player: Player, timeline: Timeline): void {
    if (this.keyboardBound) return;
    this.keyboardBound = true;
    window.addEventListener('keydown', (e) => {
      if (this.state.phase !== 'review') return;
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
        if (!timeline.jumpToNextHazard()) toast('미검증 구간이 없습니다');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = this.state.selectedTrack();
        const project = this.state.project;
        if (sel && project) {
          e.preventDefault();
          this.state.pushUndo();
          if (sel.origin === 'manual') {
            project.tracks = project.tracks.filter((t) => t.id !== sel.id);
          } else {
            sel.enabled = false; // 자동 트랙은 삭제 대신 끈다 (되돌릴 수 있게)
          }
          this.state.selectedTrackId = null;
          this.state.emit('selection');
          this.state.emit('project');
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (this.state.undo()) toast('되돌렸습니다');
      }
    });
  }

  private exportChoice: number | null | 'unset' = 'unset';

  /** 내보내기 해상도 선택 모달 → 선택 시 렌더 시작 */
  private exportVideo(): void {
    const project = this.state.project;
    if (!project || this.rendering) return;
    const { width, height } = project.source;
    const maxSide = Math.max(width, height);

    const dims = (cap: number | null): string => {
      const s = cap ? Math.min(1, cap / maxSide) : 1;
      const even = (v: number): number => Math.max(2, Math.round(v * s)) & ~1;
      return `${even(width)}×${even(height)}`;
    };

    const options: { label: string; value: number | null }[] = [];
    options.push({ label: `원본 — ${dims(null)}`, value: null });
    if (maxSide > 1920) options.push({ label: `1080p — ${dims(1920)}`, value: 1920 });
    if (maxSide > 1280) options.push({ label: `720p — ${dims(1280)}`, value: 1280 });

    // 기본값: 4K 초과 소스는 1080p (완주 안정성), 그 외 원본
    const defaultValue = this.exportChoice !== 'unset' ? this.exportChoice : maxSide > 2160 ? 1920 : null;

    openModal((modal, close) => {
      const h = document.createElement('h3');
      h.textContent = '내보내기';
      const p = document.createElement('p');
      p.textContent = '해상도';
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
          original && maxSide > 2160
            ? '원본(4K) 그대로 내보내면 기기에 따라 시간이 오래 걸리거나 메모리 부족으로 실패할 수 있습니다.'
            : '';
      };
      select.addEventListener('change', updateWarn);
      updateWarn();

      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancel = document.createElement('button');
      cancel.textContent = '취소';
      cancel.addEventListener('click', close);
      const go = document.createElement('button');
      go.className = 'primary';
      go.textContent = '내보내기';
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

  private async runRender(maxLongSide: number | null): Promise<void> {
    const state = this.state;
    const project = state.project;
    const file = state.file;
    if (!project || !file || this.rendering) return;

    this.rendering = true;
    state.phase = 'rendering';
    const progress = openProgressModal('내보내는 중', () => this.client.cancel());
    try {
      const blob = await this.client.render(file, project, maxLongSide, (p) => progress.update(p));
      progress.close();
      const outName = `${file.name.replace(/\.[^.]+$/, '')}_scrim.mp4`;
      const saved = await saveBlob(blob, outName, 'video/mp4', '.mp4');
      if (saved) toast('내보냈습니다');
    } catch (e) {
      progress.close();
      if (e instanceof DOMException && e.name === 'AbortError') {
        toast('내보내기를 취소했습니다');
      } else {
        toast(`내보내기 실패: ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      this.rendering = false;
      state.phase = 'review';
    }
  }
}

// ── 부트 ─────────────────────────────────────────────
if (!featureSupported()) {
  renderUnsupported(app);
} else {
  new App(app);
}
