/**
 * WebCodecs 인코더 + mp4-muxer 먹싱.
 * 비디오는 재인코딩, 오디오는 원본 청크 무손실 패스스루(addAudioChunkRaw).
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { AudioPassthrough } from './demux';

const MAX_ENCODE_QUEUE = 8;
const KEYFRAME_INTERVAL_US = 2_000_000; // 2초
const CODEC_FALLBACKS = ['avc1.42E01F', 'avc1.4D401F', 'avc1.640028'];

export interface EncoderOptions {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audio: AudioPassthrough | null;
}

export interface Encoder {
  encodeFrame(frame: VideoFrame): Promise<void>;
  finalize(): Promise<Blob>;
  close(): void;
}

export async function createEncoder(opts: EncoderOptions): Promise<Encoder> {
  // 인코더는 짝수 해상도를 요구한다
  const width = opts.width - (opts.width % 2);
  const height = opts.height - (opts.height % 2);

  let codec: string | null = null;
  for (const candidate of CODEC_FALLBACKS) {
    const support = await VideoEncoder.isConfigSupported({
      codec: candidate,
      width,
      height,
      bitrate: opts.bitrate,
      framerate: opts.fps,
    });
    if (support.supported) {
      codec = candidate;
      break;
    }
  }
  if (!codec) throw new Error('이 브라우저에서 H.264 인코딩을 지원하지 않습니다.');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(opts.audio
      ? {
          audio: {
            codec: 'aac' as const,
            numberOfChannels: opts.audio.config.numberOfChannels,
            sampleRate: opts.audio.config.sampleRate,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });

  let error: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (error = e instanceof Error ? e : new Error(String(e))),
  });
  encoder.configure({
    codec,
    width,
    height,
    bitrate: opts.bitrate,
    framerate: opts.fps,
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
  });

  let lastKeyUs = -Infinity;
  const audioData: { data: Uint8Array; type: 'key' | 'delta'; ts: number; dur: number }[] = [];
  if (opts.audio) {
    for (const c of opts.audio.chunks) {
      const buf = new Uint8Array(c.byteLength);
      c.copyTo(buf);
      audioData.push({ data: buf, type: c.type as 'key' | 'delta', ts: c.timestamp, dur: c.duration ?? 0 });
    }
  }

  return {
    async encodeFrame(frame: VideoFrame): Promise<void> {
      if (error) throw error;
      // 백프레셔
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        await new Promise<void>((r) => encoder.addEventListener('dequeue', () => r(), { once: true }));
        if (error) throw error;
      }
      const keyFrame = frame.timestamp - lastKeyUs >= KEYFRAME_INTERVAL_US;
      if (keyFrame) lastKeyUs = frame.timestamp;
      encoder.encode(frame, { keyFrame });
    },
    async finalize(): Promise<Blob> {
      await encoder.flush();
      if (error) throw error;
      encoder.close();
      for (const a of audioData) {
        muxer.addAudioChunkRaw(a.data, a.type, a.ts, a.dur);
      }
      muxer.finalize();
      const { buffer } = muxer.target as ArrayBufferTarget;
      return new Blob([buffer], { type: 'video/mp4' });
    },
    close(): void {
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch {
        /* noop */
      }
    },
  };
}

/** 비트레이트 기본값. 원본보다 낮아지지 않게 하한 적용. */
export function defaultBitrate(width: number, height: number, fps: number, sourceFileBytes: number, durationUs: number): number {
  const computed = width * height * fps * 0.09; // 1080p30 ≈ 5.6Mbps
  const durationS = durationUs / 1e6;
  const sourceBitrate = durationS > 0 ? (sourceFileBytes * 8) / durationS : 0;
  return Math.round(Math.max(computed, Math.min(sourceBitrate, 20_000_000)));
}
