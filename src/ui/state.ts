/**
 * 앱 상태 + 되돌리기 스택. 외부 상태 관리 라이브러리 금지 — 직접 관리한다.
 */
import type { FrameIndex, Project, RedactStyle, Track } from '../types';

export type StateEvent =
  | 'project' // 트랙/스타일 변경
  | 'selection'
  | 'time'
  | 'playback'
  | 'phase';

export type AppPhase = 'landing' | 'analyzing' | 'review' | 'rendering';

const UNDO_DEPTH = 50;

interface Snapshot {
  tracks: Track[];
  globalStyle: RedactStyle;
}

export class AppState {
  phase: AppPhase = 'landing';
  file: File | null = null;
  project: Project | null = null;
  frames: FrameIndex | null = null;
  /** 현재 재생 위치 (마이크로초) */
  currentUs = 0;
  playing = false;
  selectedTrackId: string | null = null;
  /** 일괄 수정용 다중 선택 (체크박스) */
  checkedIds = new Set<string>();
  manualSeq = 0;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Map<StateEvent, Set<() => void>>();

  on(event: StateEvent, fn: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(event: StateEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  private snapshot(): Snapshot {
    return {
      tracks: structuredClone(this.project!.tracks),
      globalStyle: structuredClone(this.project!.globalStyle),
    };
  }

  private restore(snap: Snapshot): void {
    this.project!.tracks = snap.tracks;
    this.project!.globalStyle = snap.globalStyle;
    if (this.selectedTrackId && !this.project!.tracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = null;
      this.emit('selection');
    }
    this.emit('project');
  }

  /** 변경 직전에 호출 — 프로젝트 상태 스냅샷 (깊이 50). 새 변경은 redo 히스토리를 무효화한다 */
  pushUndo(): void {
    if (!this.project) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap || !this.project) return false;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap || !this.project) return false;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.restore(snap);
    return true;
  }

  selectedTrack(): Track | null {
    if (!this.project || !this.selectedTrackId) return null;
    return this.project.tracks.find((t) => t.id === this.selectedTrackId) ?? null;
  }

  /** 체크된 트랙들 (삭제된 ID는 자동 제외) */
  checkedTracks(): Track[] {
    if (!this.project) return [];
    return this.project.tracks.filter((t) => this.checkedIds.has(t.id));
  }

  toggleChecked(id: string): void {
    if (this.checkedIds.has(id)) this.checkedIds.delete(id);
    else this.checkedIds.add(id);
    this.emit('selection');
  }

  setTime(us: number): void {
    const dur = this.project?.source.durationUs ?? 0;
    this.currentUs = Math.max(0, Math.min(dur, us));
    this.emit('time');
  }

  nextManualId(): string {
    return `M${++this.manualSeq}`;
  }
}
