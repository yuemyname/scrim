/**
 * WebCodecs 디코드 스트림.
 *
 * 규약: onFrame 호출자가 아니라 **onFrame 구현자가 frame.close()의 책임을 진다.**
 * VideoFrame을 배열에 담아두는 순간 메모리 예산이 깨진다 — 좌표만 남기고 즉시 닫을 것.
 *
 * 출력 순서: VideoDecoder는 presentation 순서로 프레임을 내보내지만,
 * 이 모듈의 소비자는 timestamp 기준으로만 동작해야 한다 (B-frame 안전).
 *
 * 재시도: 일부 브라우저(특히 WebKit)는 isConfigSupported를 통과한 설정에서도
 * 런타임에 'Decoder failure'로 죽는다. 프레임이 하나도 나오기 전에 실패하면
 * 설정 변형(치수 제거, avc1↔avc3 / hvc1↔hev1 교체)으로 재시도한다.
 */

import { waitDequeue } from './queue';

const MAX_DECODE_QUEUE = 8;

export async function decodeStream(
  chunks: EncodedVideoChunk[],
  config: VideoDecoderConfig,
  onFrame: (frame: VideoFrame) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const variants = configVariants(config);
  let lastError: unknown = null;
  let anySupported = false;

  for (const cfg of variants) {
    if (signal.aborted) throw new DOMException('취소되었습니다', 'AbortError');
    const support = await VideoDecoder.isConfigSupported(cfg).catch(() => null);
    if (!support?.supported) continue;
    anySupported = true;

    let delivered = 0;
    try {
      await decodeOnce(chunks, cfg, async (frame) => {
        delivered++;
        await onFrame(frame);
      }, signal);
      return;
    } catch (e) {
      lastError = e;
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      // 프레임이 이미 소비됐다면 재시도 시 중복 전달되므로 여기서 멈춘다
      if (delivered > 0) break;
      console.warn(`[scrim] 디코드 실패, 설정 변형으로 재시도 (${cfg.codec})`, e);
    }
  }

  if (!anySupported) {
    const isHevc = config.codec.toLowerCase().startsWith('hvc') || config.codec.toLowerCase().startsWith('hev');
    throw new Error(
      `이 브라우저에서 디코드할 수 없는 형식입니다 (${config.codec}).` +
        (isHevc ? ' H.265(HEVC) 영상은 브라우저·기기에 따라 지원되지 않을 수 있습니다.' : ''),
    );
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`디코드 실패 (${config.codec}): ${msg}`);
}

/** 브라우저 호환성을 높이는 순서로 설정 변형을 만든다 */
function configVariants(config: VideoDecoderConfig): VideoDecoderConfig[] {
  const variants: VideoDecoderConfig[] = [config];

  // 1) coded 치수 제거 — 일부 WebKit은 치수 불일치에 민감하다
  if (config.codedWidth || config.codedHeight) {
    const { codedWidth: _w, codedHeight: _h, ...rest } = config;
    variants.push(rest as VideoDecoderConfig);
  }

  // 2) 포맷 형제 코덱으로 교체 (avc1↔avc3, hvc1↔hev1)
  const swapped = config.codec
    .replace(/^avc1/, '@AVC3@')
    .replace(/^avc3/, 'avc1')
    .replace('@AVC3@', 'avc3')
    .replace(/^hvc1/, '@HEV1@')
    .replace(/^hev1/, 'hvc1')
    .replace('@HEV1@', 'hev1');
  if (swapped !== config.codec) {
    variants.push({ ...config, codec: swapped });
    // 인밴드 파라미터셋 형식(avc3/hev1)은 description 없이도 시도해 본다
    if (/^(avc3|hev1)/.test(swapped) && config.description) {
      const { description: _d, codedWidth: _w2, codedHeight: _h2, ...rest } = config;
      variants.push({ ...rest, codec: swapped } as VideoDecoderConfig);
    }
  }
  return variants;
}

function decodeOnce(
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
      signal.removeEventListener('abort', onAbort);
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
      try {
        decoder.configure(config);
      } catch (e) {
        throw new Error(`디코더 설정 실패 (${config.codec}): ${e instanceof Error ? e.message : e}`);
      }
      for (const chunk of chunks) {
        if (failed || signal.aborted) return;
        // 백프레셔: 큐가 쌓이면 대기. 없으면 1080p 장시간 영상에서 탭이 죽는다.
        // dequeue 이벤트 미지원 브라우저 대비 타임아웃 폴백 포함.
        while (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
          await waitDequeue(decoder);
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
