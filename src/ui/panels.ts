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
  private batchEl: HTMLElement;
  private styleEl: HTMLElement;

  constructor(state: AppState) {
    this.state = state;
    this.root = document.createElement('aside');
    this.root.className = 'sidebar';

    const tracksTitle = document.createElement('h2');
    tracksTitle.textContent = 'TRACKS';
    this.batchEl = document.createElement('div');
    this.batchEl.className = 'batch-bar';
    this.listEl = document.createElement('ul');
    this.listEl.className = 'track-list';

    const styleTitle = document.createElement('h2');
    styleTitle.textContent = 'STYLE';
    this.styleEl = document.createElement('div');
    this.styleEl.className = 'style-panel';

    this.root.append(tracksTitle, this.batchEl, this.listEl, styleTitle, this.styleEl);

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
    this.batchEl.replaceChildren();
    if (!project) return;

    if (project.tracks.length === 0) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = '얼굴을 찾지 못했습니다. 화면 위에서 드래그해 수동으로 지정하세요.';
      this.listEl.after(note);
      return;
    }

    // 일괄 작업 바 — 전체 선택/해제 토글은 항상, 나머지는 체크된 트랙이 있을 때
    const checked = this.state.checkedTracks();
    const act = (text: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', fn);
      return b;
    };

    const allChecked = checked.length === project.tracks.length;
    this.batchEl.append(
      act(allChecked ? '전체 해제' : '전체 선택', () => {
        this.state.checkedIds.clear();
        if (!allChecked) for (const t of project.tracks) this.state.checkedIds.add(t.id);
        this.state.emit('selection');
      }),
    );

    if (checked.length > 0) {
      const label = document.createElement('span');
      label.textContent = `${checked.length}개 선택`;
      this.batchEl.append(
        label,
        act('끄기', () => {
          this.state.pushUndo();
          for (const t of checked) t.enabled = false;
          this.state.emit('project');
        }),
        act('켜기', () => {
          this.state.pushUndo();
          for (const t of checked) t.enabled = true;
          this.state.emit('project');
        }),
        act('삭제', () => {
          this.state.pushUndo();
          const ids = new Set(checked.map((t) => t.id));
          project.tracks = project.tracks.filter((t) => !ids.has(t.id));
          this.state.checkedIds.clear();
          if (this.state.selectedTrackId && ids.has(this.state.selectedTrackId)) this.state.selectedTrackId = null;
          this.state.emit('selection');
          this.state.emit('project');
        }),
      );
    }

    for (const track of project.tracks) {
      const li = document.createElement('li');
      li.classList.toggle('selected', track.id === this.state.selectedTrackId);
      li.classList.toggle('enabled', track.enabled);

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'track-check';
      check.checked = this.state.checkedIds.has(track.id);
      check.title = '일괄 수정 대상으로 선택';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => this.state.toggleChecked(track.id));

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

      li.append(check, dot, tid, range, origin, del);
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
    const checked = this.state.checkedTracks();
    // 편집 대상: 체크된 트랙들(일괄) > 선택 트랙 > 전체 스타일
    const targets = checked.length > 0 ? checked : sel ? [sel] : [];
    const isBatch = checked.length > 0;
    const style: RedactStyle = targets[0]?.style ?? project.globalStyle;
    const isOverride = Boolean(targets[0]?.style);

    // 대상 각각에 오버라이드를 만들며 변경을 적용한다 (대상 없으면 전체 스타일)
    const apply = (mut: (s: RedactStyle) => void): void => {
      if (targets.length > 0) {
        for (const t of targets) {
          if (!t.style) t.style = structuredClone(project.globalStyle);
          mut(t.style);
        }
      } else {
        mut(project.globalStyle);
      }
    };
    const commit = (mut: (s: RedactStyle) => void): void => {
      this.state.pushUndo();
      apply(mut);
      this.state.emit('project');
    };

    const target = document.createElement('div');
    target.className = 'row';
    target.style.color = 'var(--ink-muted)';
    target.textContent = isBatch
      ? `${checked.length}개 트랙 일괄 수정`
      : sel
        ? `${sel.id} 트랙 스타일${isOverride ? ' (개별)' : ' (전체 상속)'}`
        : '전체 스타일';
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
      { k: 'blur', label: '블러', title: '블러는 반경이 작으면 복원될 수 있어 최소 강도가 강제됩니다' },
      { k: 'sticker', label: '스티커', title: '모자이크 바탕 위에 이모지/문구를 얹습니다' },
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
        set(Number(input.value));
        this.state.emit('project');
      });
      row.append(l, input);
      this.styleEl.appendChild(row);
    };

    if (style.kind === 'mosaic') {
      slider('강도', style.strength, 0.04, 0.3, 0.01, (v) => apply((s) => (s.strength = v)));
    } else if (style.kind === 'blur') {
      slider('강도', Math.max(style.strength, 12), 12, 60, 1, (v) => apply((s) => (s.strength = v)));
    } else if (style.kind === 'sticker') {
      // 이모지/문구 입력 + 빠른 선택
      const row = document.createElement('div');
      row.className = 'row';
      const l = document.createElement('label');
      l.textContent = '내용';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sticker-input';
      input.maxLength = 20;
      input.value = style.sticker ?? '🙂';
      input.placeholder = '🙂 또는 문구';
      let pushed = false;
      input.addEventListener('input', () => {
        if (!pushed) {
          this.state.pushUndo();
          pushed = true;
        }
        apply((s) => (s.sticker = input.value));
        this.state.emit('project');
      });
      row.append(l, input);
      this.styleEl.appendChild(row);

      const presets = document.createElement('div');
      presets.className = 'row sticker-presets';
      for (const e of ['🙂', '😎', '🐻', '⭐️', '🌸', '🫥']) {
        const b = document.createElement('button');
        b.textContent = e;
        b.addEventListener('click', () => commit((s) => (s.sticker = e)));
        presets.appendChild(b);
      }
      this.styleEl.appendChild(presets);
    }
    slider('여백', style.scale, 1.0, 2.2, 0.05, (v) => apply((s) => (s.scale = v)));
    slider('페더', style.feather, 0, 0.6, 0.05, (v) => apply((s) => (s.feather = v)));

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

    if (targets.length > 0 && targets.some((t) => t.style)) {
      const reset = document.createElement('button');
      reset.textContent = isBatch ? '선택 트랙들 전체 스타일로 되돌리기' : '전체 스타일로 되돌리기';
      reset.addEventListener('click', () => {
        this.state.pushUndo();
        for (const t of targets) t.style = null;
        this.state.emit('project');
      });
      this.styleEl.appendChild(reset);
    }
  }
}
