import type { Box, FrameIndex, Progress, Project, TrackSample } from '../types';

export type WorkerRequest =
  | { type: 'analyze'; jobId: number; file: File; minConfidence: number }
  | { type: 'analyzeImage'; jobId: number; file: File; minConfidence: number }
  | { type: 'render'; jobId: number; file: File; project: Project; maxLongSide: number | null }
  | {
      type: 'trackRegion';
      jobId: number;
      file: File;
      startUs: number;
      endUs: number;
      initBox: Box;
      minConfidence: number;
    }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'progress'; jobId: number; progress: Progress }
  | { type: 'analyzed'; jobId: number; project: Project; frames: FrameIndex }
  | { type: 'rendered'; jobId: number; blob: Blob }
  | { type: 'tracked'; jobId: number; samples: TrackSample[] }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string; unsupported: boolean };
