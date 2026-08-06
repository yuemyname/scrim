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
 * 런타임에 'Decoder failure'로 죽는다. 설정 변형(치수 제거, avc1↔avc3 /
 * hvc1↔hev1 교체, 소프트웨어 디코더 강제)으로 재시도하며, 이미 전달한
 * 프레임은 timestamp로 걸러내므로 중간에 죽어도 이어서 재시도할 수 있다.
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
  // presentation 순서로 나오므로 timestamp는 단조 증가 — 재시도 시 이미
  // 전달한 프레임은 여기서 걸러 중복 전달을 막는다.
  let lastDeliveredTs = -Infinity;

  for (const cfg of variants) {
    if (signal.aborted) throw new DOMException('취소되었습니다', 'AbortError');
    const support = await VideoDecoder.isConfigSupported(cfg).catch(() => null);
    // 소프트웨어 강제 변형은 일부 WebKit이 지원 조회에서 거짓 음성을 내므로
    // 조회 결과와 무관하게 실제 configure를 시도해 본다.
    if (!support?.supported && cfg.hardwareAcceleration !== 'prefer-software') continue;
    if (support?.supported) anySupported = true;

    try {
      await decodeOnce(chunks, cfg, async (frame) => {
        if (frame.timestamp <= lastDeliveredTs) {
          frame.close();
          return;
        }
        lastDeliveredTs = frame.timestamp;
        await onFrame(frame);
      }, signal);
      return;
    } catch (e) {
      lastError = e;
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
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

  // 3) 소프트웨어 디코더 강제 — iPad의 하드웨어 H.264/HEVC 디코더는
  //    isConfigSupported를 통과하고도 런타임에 'Decoder failure'로 죽는
  //    스트림이 있다 (특히 High 프로필). 위 변형 전부를 소프트웨어로도
  //    시도한다. 힌트를 모르는 브라우저는 그냥 무시하므로 무해하다.
  for (const v of variants.slice()) {
    variants.push({ ...v, hardwareAcceleration: 'prefer-software' });
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
