import type { FrameIndex, Progress, Project } from '../types';

export type WorkerRequest =
  | { type: 'analyze'; jobId: number; file: File; longSide: number }
  | { type: 'render'; jobId: number; file: File; project: Project; maxLongSide: number | null }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'progress'; jobId: number; progress: Progress }
  | { type: 'analyzed'; jobId: number; project: Project; frames: FrameIndex }
  | { type: 'rendered'; jobId: number; blob: Blob }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string; unsupported: boolean };
