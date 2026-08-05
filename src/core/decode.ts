/**
 * WebCodecs 디코드 스트림.
 *
 * 규약: onFrame 호출자가 아니라 **onFrame 구현자가 frame.close()의 책임을 진다.**
 * VideoFrame을 배열에 담아두는 순간 메모리 예산이 깨진다 — 좌표만 남기고 즉시 닫을 것.
 *
 * 출력 순서: VideoDecoder는 presentation 순서로 프레임을 내보내지만,
 * 이 모듈의 소비자는 timestamp 기준으로만 동작해야 한다 (B-frame 안전).
 */

const MAX_DECODE_QUEUE = 8;

export function decodeStream(
  chunks: EncodedVideoChunk[],
  config: VideoDecoderConfig,
  onFrame: (frame: VideoFrame) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // onFrame이 async이므로 출력 콜백을 순차 체인으로 직렬화한다
    let chain: Promise<void> = Promise.resolve();
    let failed = false;

    const fail = (e: unknown): void => {
      if (failed) return;
      failed = true;
      try {
        if (decoder.state !== 'closed') decoder.close();
      } catch {
        /* already closed */
      }
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    const decoder = new VideoDecoder({
      output: (frame) => {
        chain = chain.then(() => {
          if (failed || signal.aborted) {
            frame.close();
            return;
          }
          return onFrame(frame);
        });
        chain = chain.catch(fail);
      },
      error: fail,
    });

    const onAbort = (): void => fail(new DOMException('취소되었습니다', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });

    const run = async (): Promise<void> => {
      decoder.configure(config);
      for (const chunk of chunks) {
        if (failed || signal.aborted) return;
        // 백프레셔: 큐가 쌓이면 대기. 없으면 1080p 장시간 영상에서 탭이 죽는다.
        while (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
          await new Promise<void>((r) => decoder.addEventListener('dequeue', () => r(), { once: true }));
          if (failed || signal.aborted) return;
        }
        decoder.decode(chunk);
      }
      await decoder.flush();
      await chain;
      if (!failed) {
        decoder.close();
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
    };

    run().catch(fail);
  });
}
