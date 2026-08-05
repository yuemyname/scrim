/**
 * MP4 디먹싱. mp4box.js로 파싱해 비디오는 EncodedVideoChunk로,
 * 오디오는 디코드 없이 원본 청크 그대로 추출한다 (무손실 패스스루).
 */
import { createFile, DataStream } from 'mp4box';
import type { MP4File, MP4Info, MP4MediaTrack, MP4Sample, SampleEntry } from 'mp4box';
import type { SourceMeta } from '../types';

/**
 * 오디오 원본 샘플. EncodedAudioChunk를 쓰지 않는 이유:
 * Safari는 WebCodecs 오디오 클래스가 없는 버전이 많고, 우리는 디코드하지 않으므로
 * muxer에 그대로 넘길 순수 데이터만 있으면 된다.
 */
export interface AudioSample {
  data: Uint8Array;
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
}

export interface AudioPassthrough {
  config: { codec: string; numberOfChannels: number; sampleRate: number };
  description: Uint8Array; // esds / AudioSpecificConfig
  chunks: AudioSample[];
}

export interface DemuxResult {
  meta: SourceMeta;
  videoConfig: VideoDecoderConfig;
  /** 디코드 순서로 정렬된 청크 */
  videoChunks: EncodedVideoChunk[];
  audio: AudioPassthrough | null;
}

export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}

const READ_CHUNK = 8 * 1024 * 1024;
/** 4K(3840×2160, DCI 4096 포함)까지 받는다. 4K 소스는 렌더 시 1080p로 다운스케일된다. */
const MAX_LONG_SIDE = 4096;

/** demux 내부 하위 단계를 오류 메시지에 라벨링한다 */
function sub(label: string, e: unknown): Error {
  if (e instanceof Error && (e.name === 'UnsupportedSourceError' || e.name === 'AbortError')) return e;
  const name = e instanceof Error && e.name !== 'Error' ? `${e.name}: ` : '';
  return new Error(`(${label}) ${name}${e instanceof Error ? e.message : String(e)}`);
}

const KNOWN_TOP_BOXES = new Set(['ftyp', 'styp', 'moov', 'moof', 'free', 'skip', 'wide', 'mdat', 'pnot', 'uuid']);

/** MP4(ISOBMFF)가 맞는지 첫 박스로 확인. 확장자만 .mp4인 다른 형식을 명확히 걸러낸다. */
async function verifyContainer(file: File): Promise<void> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 8) throw new UnsupportedSourceError('파일이 비어 있거나 너무 작습니다.');
  const fourcc = String.fromCharCode(head[4] ?? 0, head[5] ?? 0, head[6] ?? 0, head[7] ?? 0);
  if (!KNOWN_TOP_BOXES.has(fourcc)) {
    const hex = Array.from(head.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
    const hint =
      head[0] === 0x1a && head[1] === 0x45 ? ' WebM/MKV 형식으로 보입니다.' : '';
    throw new UnsupportedSourceError(
      `MP4 파일이 아닌 것 같습니다 (시작 바이트: ${hex}, 타입: ${file.type || '알 수 없음'}).${hint} 확장자와 무관하게 실제 형식이 MP4여야 합니다.`,
    );
  }
}

export async function demux(file: File): Promise<DemuxResult> {
  await verifyContainer(file);
  const mp4 = createFile();

  const videoSamples: MP4Sample[] = [];
  const audioSamples: MP4Sample[] = [];
  let info: MP4Info | null = null;
  let videoTrack: MP4MediaTrack | null = null;
  let audioTrack: MP4MediaTrack | null = null;

  const ready = new Promise<MP4Info>((resolve, reject) => {
    mp4.onReady = resolve;
    mp4.onError = (e) => reject(new Error(`mp4 파싱 실패: ${e}`));
  });

  mp4.onSamples = (id, _user, samples) => {
    // 주의: releaseUsedSamples는 "같은 샘플 객체"의 data를 null로 만든다.
    // 원본 객체를 보관하면 청크 생성 시점에 데이터가 사라져 있다 → 필드 스냅샷을 뜬다.
    // data(Uint8Array) 참조는 우리가 쥐고 있으므로 버퍼는 살아남는다.
    const target =
      videoTrack && id === videoTrack.id ? videoSamples : audioTrack && id === audioTrack.id ? audioSamples : null;
    if (target) {
      for (const s of samples) {
        target.push({
          number: s.number,
          track_id: s.track_id,
          timescale: s.timescale,
          dts: s.dts,
          cts: s.cts,
          duration: s.duration,
          is_sync: s.is_sync,
          data: s.data,
        });
      }
    }
    mp4.releaseUsedSamples(id, samples[samples.length - 1]?.number ?? 0);
  };

  // 파일을 청크 단위로 흘려 넣는다. onReady는 moov를 만나면 호출된다.
  let offset = 0;
  const feed = async (until: () => boolean): Promise<void> => {
    while (offset < file.size && !until()) {
      const slice = file.slice(offset, offset + READ_CHUNK);
      const buf = (await slice.arrayBuffer()) as ArrayBuffer & { fileStart: number };
      buf.fileStart = offset;
      offset += buf.byteLength;
      mp4.appendBuffer(buf);
    }
  };

  let readyDone = false;
  void ready.then(() => (readyDone = true)).catch(() => (readyDone = true));
  try {
    await feed(() => readyDone);
    info = await ready;
  } catch (e) {
    throw sub('mp4 파싱', e);
  }

  videoTrack = info.videoTracks[0] ?? null;
  if (!videoTrack) throw new UnsupportedSourceError('비디오 트랙이 없습니다.');
  audioTrack = info.audioTracks[0] ?? null;

  rejectUnsupported(mp4, videoTrack);

  // 샘플 추출 설정 후 나머지 전부 흘려 넣는다
  try {
    mp4.setExtractionOptions(videoTrack.id, null, { nbSamples: 500 });
    if (audioTrack) mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: 1000 });
    mp4.start();
    await feed(() => false);
    mp4.flush();
    mp4.stop();
  } catch (e) {
    throw sub('샘플 추출', e);
  }

  if (videoSamples.length === 0) throw new UnsupportedSourceError('비디오 샘플을 추출하지 못했습니다.');

  const rotation = rotationFromMatrix(videoTrack.matrix);
  const codedW = videoTrack.video?.width ?? videoTrack.track_width;
  const codedH = videoTrack.video?.height ?? videoTrack.track_height;
  const swap = rotation === 90 || rotation === 270;

  const durationUs = Math.round(((videoTrack.duration || info.duration) / (videoTrack.timescale || info.timescale)) * 1e6);

  const meta: SourceMeta = {
    fileName: file.name,
    width: swap ? codedH : codedW,
    height: swap ? codedW : codedH,
    durationUs,
    frameCount: videoSamples.length,
    rotation,
    codec: videoTrack.codec,
    hasAudio: false,
  };

  // avcC/hvcC description — 없으면 Safari에서 디코드가 실패한다.
  // avc3/hev1(인밴드 파라미터셋)은 description 없이도 되는 브라우저가 있어 시도는 하되,
  // avc1/hvc1인데 추출이 실패하면 명확히 거절한다.
  const description = extractVideoDescription(mp4, videoTrack.id);
  const codecLower = videoTrack.codec.toLowerCase();
  if (!description && (codecLower.startsWith('avc1') || codecLower.startsWith('hvc1'))) {
    throw new UnsupportedSourceError('영상의 코덱 설정 정보(avcC/hvcC)를 읽지 못했습니다. 파일이 손상되었거나 비표준 형식입니다.');
  }
  const videoConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    codedWidth: codedW,
    codedHeight: codedH,
    ...(description ? { description } : {}),
  };

  // NaN/Infinity 타임스탬프는 EncodedVideoChunk에서 TypeError를 유발한다 — 유한값 강제
  const toUs = (v: number, timescale: number): number => {
    const r = Math.round((v / timescale) * 1e6);
    return Number.isFinite(r) ? r : 0;
  };

  let videoChunks: EncodedVideoChunk[];
  try {
    videoChunks = videoSamples.map((s) => {
      if (!s.data || s.data.length === 0) {
        throw new UnsupportedSourceError(`샘플 #${s.number}의 데이터가 비어 있습니다. 파일이 손상되었을 수 있습니다.`);
      }
      return new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: toUs(s.cts, s.timescale),
        duration: toUs(s.duration, s.timescale),
        data: s.data,
      });
    });
  } catch (e) {
    throw sub('비디오 청크 생성', e);
  }

  // 오디오는 어떤 이유로 실패하든 영상 처리를 막지 않는다 → null 폴백 (UI 경고)
  let audio: AudioPassthrough | null = null;
  if (audioTrack && audioSamples.length > 0) {
    try {
      audio = buildAudioPassthrough(mp4, audioTrack, audioSamples, toUs);
    } catch (e) {
      console.warn('[scrim] 오디오 추출 실패, 영상만 처리:', e);
      audio = null;
    }
    meta.hasAudio = audio !== null;
  }

  return { meta, videoConfig, videoChunks, audio };
}

function rejectUnsupported(mp4: MP4File, track: MP4MediaTrack): void {
  const codec = track.codec.toLowerCase();
  const isAvc = codec.startsWith('avc1') || codec.startsWith('avc3');
  const isHevc = codec.startsWith('hvc1') || codec.startsWith('hev1');
  if (!isAvc && !isHevc) {
    throw new UnsupportedSourceError(`지원하지 않는 코덱입니다 (${track.codec}). H.264 또는 H.265 MP4만 처리합니다.`);
  }

  const w = track.video?.width ?? track.track_width;
  const h = track.video?.height ?? track.track_height;
  if (Math.max(w, h) > MAX_LONG_SIDE) {
    throw new UnsupportedSourceError('4K를 초과하는 영상은 지원하지 않습니다 (긴 변 4096px 이하).');
  }

  // 10-bit 감지: avcC 프로파일 / hvcC bitDepth
  const entry = findEntry(mp4, track.id, (e) => Boolean(e.avcC || e.hvcC));
  if (entry?.avcC) {
    const profile = (entry.avcC as { AVCProfileIndication?: number }).AVCProfileIndication;
    if (profile === 110 || profile === 122 || profile === 244) {
      throw new UnsupportedSourceError('10-bit 영상은 지원하지 않습니다.');
    }
  }
  if (entry?.hvcC) {
    const depth = (entry.hvcC as { bit_depth_luma_minus8?: number }).bit_depth_luma_minus8;
    if (typeof depth === 'number' && depth > 0) {
      throw new UnsupportedSourceError('10-bit 영상은 지원하지 않습니다.');
    }
  }
}

function findEntry(mp4: MP4File, trackId: number, pred: (e: SampleEntry) => boolean): SampleEntry | null {
  try {
    const trak = mp4.getTrackById(trackId);
    return trak.mdia.minf.stbl.stsd.entries.find(pred) ?? null;
  } catch {
    return null;
  }
}

function extractVideoDescription(mp4: MP4File, trackId: number): Uint8Array | null {
  try {
    const entry = findEntry(mp4, trackId, (e) => Boolean(e.avcC || e.hvcC));
    const box = entry?.avcC ?? entry?.hvcC;
    if (!box) return null;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    // 앞 8바이트(box header: size + fourcc)를 제거한 본문이 description이다
    return new Uint8Array(stream.buffer, 8);
  } catch {
    return null;
  }
}

/** mp4 tkhd matrix에서 회전각을 유도한다. 무시하면 세로 촬영 영상의 좌표가 90도 틀어진다. */
function rotationFromMatrix(matrix: Int32Array | number[] | undefined): number {
  if (!matrix || matrix.length < 5) return 0;
  const a = Number(matrix[0]) / 65536;
  const b = Number(matrix[1]) / 65536;
  const deg = (Math.round((Math.atan2(b, a) * 180) / Math.PI) + 360) % 360;
  if (deg > 45 && deg <= 135) return 90;
  if (deg > 135 && deg <= 225) return 180;
  if (deg > 225 && deg <= 315) return 270;
  return 0;
}

function buildAudioPassthrough(
  mp4: MP4File,
  track: MP4MediaTrack,
  samples: MP4Sample[],
  toUs: (v: number, ts: number) => number,
): AudioPassthrough | null {
  // AAC(mp4a.40.x)만 패스스루. 그 외 코덱은 remux 불가 → null 폴백 (UI에서 경고)
  if (!track.codec.toLowerCase().startsWith('mp4a')) return null;

  const entry = findEntry(mp4, track.id, (e) => Boolean(e.esds));
  const decoderConfig = entry?.esds?.esd?.descs?.find((d) => d.tag === 4);
  const specificInfo = decoderConfig?.descs?.find((d) => d.tag === 5);
  const description = specificInfo?.data;
  if (!description || description.length === 0) return null;

  const chunks: AudioSample[] = samples.map((s) => ({
    data: s.data,
    type: s.is_sync ? ('key' as const) : ('delta' as const),
    timestampUs: toUs(s.cts, s.timescale),
    durationUs: toUs(s.duration, s.timescale),
  }));

  return {
    config: {
      codec: track.codec,
      numberOfChannels: track.audio?.channel_count ?? 2,
      sampleRate: track.audio?.sample_rate ?? 48000,
    },
    description: new Uint8Array(description),
    chunks,
  };
}
