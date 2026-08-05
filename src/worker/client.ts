/**
 * 메인 스레드에서 파이프라인 워커를 Promise API로 감싼다.
 */
import type { FrameIndex, Progress, Project } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

export class PipelineClient {
  private worker: Worker;
  private jobSeq = 0;
  private pending: Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      onProgress?: (p: Progress) => void;
    }
  > = new Map();

  constructor() {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      for (const [, job] of this.pending) job.reject(new Error(e.message || '워커 오류'));
      this.pending.clear();
    };
  }

  private handle(msg: WorkerResponse): void {
    const job = this.pending.get(msg.jobId);
    if (!job) return;
    switch (msg.type) {
      case 'progress':
        job.onProgress?.(msg.progress);
        break;
      case 'analyzed':
        this.pending.delete(msg.jobId);
        job.resolve({ project: msg.project, frames: msg.frames });
        break;
      case 'rendered':
        this.pending.delete(msg.jobId);
        job.resolve(msg.blob);
        break;
      case 'cancelled': {
        this.pending.delete(msg.jobId);
        job.reject(new DOMException('취소되었습니다', 'AbortError'));
        break;
      }
      case 'error': {
        this.pending.delete(msg.jobId);
        const err = new Error(msg.message);
        err.name = msg.unsupported ? 'UnsupportedSourceError' : 'PipelineError';
        job.reject(err);
        break;
      }
    }
  }

  private send(req: WorkerRequest): void {
    this.worker.postMessage(req);
  }

  analyze(
    file: File,
    minConfidence: number,
    onProgress?: (p: Progress) => void,
  ): Promise<{ project: Project; frames: FrameIndex }> {
    const jobId = ++this.jobSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.send({ type: 'analyze', jobId, file, minConfidence });
    });
  }

  analyzeImage(
    file: File,
    minConfidence: number,
    onProgress?: (p: Progress) => void,
  ): Promise<{ project: Project; frames: FrameIndex }> {
    const jobId = ++this.jobSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.send({ type: 'analyzeImage', jobId, file, minConfidence });
    });
  }

  render(
    file: File,
    project: Project,
    maxLongSide: number | null,
    onProgress?: (p: Progress) => void,
  ): Promise<Blob> {
    const jobId = ++this.jobSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.send({ type: 'render', jobId, file, project, maxLongSide });
    });
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }
}
