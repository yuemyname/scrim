/**
 * 분석/렌더 전용 Worker. UI 스레드 블로킹 방지.
 * AbortSignal로 취소 가능 — 10분짜리 렌더를 멈출 수 없으면 못 쓰는 도구다.
 */
import { analyze, render } from '../core/pipeline';
import { UnsupportedSourceError } from '../core/demux';
import type { WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse): void => {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
};

let controller: AbortController | null = null;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    controller?.abort();
    return;
  }

  controller = new AbortController();
  const { signal } = controller;
  const jobId = msg.jobId;

  try {
    if (msg.type === 'analyze') {
      const result = await analyze(
        msg.file,
        { minConfidence: msg.minConfidence },
        (p) => post({ type: 'progress', jobId, progress: p }),
        signal,
      );
      post({ type: 'analyzed', jobId, project: result.project, frames: result.frames });
    } else if (msg.type === 'render') {
      const blob = await render(
        msg.file,
        msg.project,
        { maxLongSide: msg.maxLongSide },
        (p) => post({ type: 'progress', jobId, progress: p }),
        signal,
      );
      post({ type: 'rendered', jobId, blob });
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      post({ type: 'cancelled', jobId });
    } else {
      console.error('[scrim worker]', err);
      const name = err instanceof Error && err.name !== 'Error' ? `${err.name}: ` : '';
      // 스택 상단을 함께 전달 — 원격 리포트만으로 위치를 특정할 수 있게
      const stack =
        err instanceof Error && err.stack
          ? `\n${err.stack.split('\n').slice(0, 3).join('\n').slice(0, 300)}`
          : '';
      post({
        type: 'error',
        jobId,
        message: `${name}${err instanceof Error ? err.message : String(err)}${stack}`,
        unsupported: err instanceof UnsupportedSourceError,
      });
    }
  } finally {
    controller = null;
  }
};
