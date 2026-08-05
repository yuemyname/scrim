/**
 * 사이드바: 트랙 리스트 + 스타일 패널.
 * 트랙을 선택하면 스타일 패널은 그 트랙의 오버라이드를 편집하고,
 * 선택이 없으면 globalStyle을 편집한다.
 */
import type { RedactStyle } from '../types';
import type { AppState } from './state';
import { shortTime } from './format';
import { trackColor } from './colors';

export class Sidebar {
  readonly root: HTMLElement;
  private state: AppState;
  private listEl: HTMLUListElement;
  private styleEl: HTMLElement;

  constructor(state: AppState) {
    this.state = state;
    this.root = document.createElement('aside');
    this.root.className = 'sidebar';

    const tracksTitle = document.createElement('h2');
    tracksTitle.textContent = 'TRACKS';
    this.listEl = document.createElement('ul');
    this.listEl.className = 'track-list';

    const styleTitle = document.createElement('h2');
    styleTitle.textContent = 'STYLE';
    this.styleEl = document.createElement('div');
    this.styleEl.className = 'style-panel';

    this.root.append(tracksTitle, this.listEl, styleTitle, this.styleEl);

    state.on('project', () => this.render());
    state.on('selection', () => this.render());
    this.render();
  }

  private render(): void {
    this.renderTracks();
    this.renderStyle();
  }

  private renderTracks(): void {
    const project = this.state.project;
    this.listEl.replaceChildren();
    if (!project) return;

    if (project.tracks.length === 0) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = '얼굴을 찾지 못했습니다. 화면 위에서 드래그해 수동으로 지정하세요.';
      this.listEl.after(note);
      return;
    }

    for (const track of project.tracks) {
      const li = document.createElement('li');
      li.classList.toggle('selected', track.id === this.state.selectedTrackId);
      li.classList.toggle('enabled', track.enabled);

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.title = track.enabled ? '가림 켜짐 — 누르면 끕니다' : '가림 꺼짐 — 누르면 켭니다';
      // 화면의 박스 보더 색과 동일한 색으로 트랙을 식별한다
      const color = trackColor(track.id);
      dot.style.borderColor = color;
      if (track.enabled) dot.style.background = color;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.state.pushUndo();
        track.enabled = !track.enabled;
        this.state.emit('project');
      });

      const tid = document.createElement('span');
      tid.className = 'tid mono';
      tid.textContent = track.id;

      const range = document.createElement('span');
      range.className = 'range mono';
      const t0 = track.samples[0]?.t ?? 0;
      const t1 = track.samples[track.samples.length - 1]?.t ?? 0;
      range.textContent = `${shortTime(t0)}–${shortTime(t1)}`;

      const origin = document.createElement('span');
      origin.className = 'origin-tag';
      // 자동 트랙은 평균 검출 신뢰도를 표시 — 낮으면(50% 미만) 오검출 의심
      origin.textContent =
        track.origin === 'manual' ? '수동' : track.avgScore !== undefined ? `${Math.round(track.avgScore * 100)}%` : '';
      if (track.origin === 'auto' && (track.avgScore ?? 1) < 0.5) origin.title = '신뢰도가 낮습니다 — 오검출인지 확인하세요';

      const del = document.createElement('button');
      del.className = 'track-delete';
      del.textContent = '✕';
      del.title = '트랙 삭제';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.state.pushUndo();
        project.tracks = project.tracks.filter((t) => t.id !== track.id);
        if (this.state.selectedTrackId === track.id) this.state.selectedTrackId = null;
        this.state.emit('selection');
        this.state.emit('project');
      });

      li.append(dot, tid, range, origin, del);
      li.addEventListener('click', () => {
        this.state.selectedTrackId = track.id;
        // 항상 트랙의 실제 시작(양끝 연장분 제외한 첫 검출/수동 샘플)으로 이동
        const first = track.samples.find((s) => s.source !== 'held') ?? track.samples[0];
        if (first) this.state.setTime(first.t);
        this.state.emit('selection');
      });
      this.listEl.appendChild(li);
    }
  }

  private renderStyle(): void {
    const project = this.state.project;
    this.styleEl.replaceChildren();
    if (!project) return;

    const sel = this.state.selectedTrack();
    const style: RedactStyle = sel?.style ?? project.globalStyle;
    const isOverride = Boolean(sel?.style);

    const commit = (mut: (s: RedactStyle) => void): void => {
      this.state.pushUndo();
      if (sel) {
        // 트랙 오버라이드 생성 후 수정
        if (!sel.style) sel.style = structuredClone(project.globalStyle);
        mut(sel.style);
      } else {
        mut(project.globalStyle);
      }
      this.state.emit('project');
    };

    const target = document.createElement('div');
    target.className = 'row';
    target.style.color = 'var(--ink-muted)';
    target.textContent = sel ? `${sel.id} 트랙 스타일${isOverride ? ' (개별)' : ' (전체 상속)'}` : '전체 스타일';
    this.styleEl.appendChild(target);

    // 종류 세그먼트
    const kindRow = document.createElement('div');
    kindRow.className = 'row';
    const kindLabel = document.createElement('label');
    kindLabel.textContent = '종류';
    const seg = document.createElement('div');
    seg.className = 'seg';
    const kinds: { k: RedactStyle['kind']; label: string; title?: string }[] = [
      { k: 'mosaic', label: '모자이크' },
      { k: 'solid', label: '솔리드' },
      { k: 'blur', label: '블러', title: '블러는 반경이 작으면 복원될 수 있어 최소 강도가 강제됩니다' },
    ];
    for (const { k, label, title } of kinds) {
      const b = document.createElement('button');
      b.textContent = label;
      if (title) b.title = title;
      b.classList.toggle('on', style.kind === k);
      b.addEventListener('click', () => commit((s) => (s.kind = k)));
      seg.appendChild(b);
    }
    kindRow.append(kindLabel, seg);
    this.styleEl.appendChild(kindRow);

    // 슬라이더
    const slider = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: number,
      set: (v: number) => void,
    ): void => {
      const row = document.createElement('div');
      row.className = 'row';
      const l = document.createElement('label');
      l.textContent = label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      let pushed = false;
      input.addEventListener('input', () => {
        if (!pushed) {
          this.state.pushUndo();
          pushed = true;
        }
        const v = Number(input.value);
        if (sel) {
          if (!sel.style) sel.style = structuredClone(project.globalStyle);
          set(v);
        } else {
          set(v);
        }
        this.state.emit('project');
      });
      row.append(l, input);
      this.styleEl.appendChild(row);
    };

    const live = (): RedactStyle => (sel ? (sel.style ?? project.globalStyle) : project.globalStyle);
    if (style.kind === 'mosaic') {
      slider('강도', style.strength, 0.04, 0.3, 0.01, (v) => (live().strength = v));
    } else if (style.kind === 'blur') {
      slider('강도', Math.max(style.strength, 12), 12, 60, 1, (v) => (live().strength = v));
    }
    slider('여백', style.scale, 1.0, 2.2, 0.05, (v) => (live().scale = v));
    slider('페더', style.feather, 0, 0.6, 0.05, (v) => (live().feather = v));

    // 모양 세그먼트
    const shapeRow = document.createElement('div');
    shapeRow.className = 'row';
    const shapeLabel = document.createElement('label');
    shapeLabel.textContent = '모양';
    const shapeSeg = document.createElement('div');
    shapeSeg.className = 'seg';
    for (const { k, label } of [
      { k: 'ellipse' as const, label: '타원' },
      { k: 'rect' as const, label: '사각' },
    ]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('on', style.shape === k);
      b.addEventListener('click', () => commit((s) => (s.shape = k)));
      shapeSeg.appendChild(b);
    }
    shapeRow.append(shapeLabel, shapeSeg);
    this.styleEl.appendChild(shapeRow);

    if (sel && isOverride) {
      const reset = document.createElement('button');
      reset.textContent = '전체 스타일로 되돌리기';
      reset.addEventListener('click', () => {
        this.state.pushUndo();
        sel.style = null;
        this.state.emit('project');
      });
      this.styleEl.appendChild(reset);
    }
  }
}
