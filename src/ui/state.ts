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
  manualSeq = 0;

  private undoStack: Snapshot[] = [];
  private listeners = new Map<StateEvent, Set<() => void>>();

  on(event: StateEvent, fn: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(event: StateEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  /** 변경 직전에 호출 — 프로젝트 상태 스냅샷 (깊이 50) */
  pushUndo(): void {
    if (!this.project) return;
    this.undoStack.push({
      tracks: structuredClone(this.project.tracks),
      globalStyle: structuredClone(this.project.globalStyle),
    });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap || !this.project) return false;
    this.project.tracks = snap.tracks;
    this.project.globalStyle = snap.globalStyle;
    if (this.selectedTrackId && !this.project.tracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = null;
      this.emit('selection');
    }
    this.emit('project');
    return true;
  }

  selectedTrack(): Track | null {
    if (!this.project || !this.selectedTrackId) return null;
    return this.project.tracks.find((t) => t.id === this.selectedTrackId) ?? null;
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
