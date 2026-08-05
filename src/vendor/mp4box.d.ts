/** mp4box.js에는 공식 타입이 없다. scrim이 사용하는 표면만 선언한다. */
declare module 'mp4box' {
  export interface MP4MediaTrack {
    id: number;
    codec: string;
    nb_samples: number;
    timescale: number;
    duration: number;
    movie_timescale: number;
    movie_duration: number;
    matrix?: Int32Array | number[];
    track_width: number;
    track_height: number;
    video?: { width: number; height: number };
    audio?: { channel_count: number; sample_rate: number; sample_size: number };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    videoTracks: MP4MediaTrack[];
    audioTracks: MP4MediaTrack[];
  }

  export interface MP4Sample {
    number: number;
    track_id: number;
    timescale: number;
    dts: number;
    cts: number;
    duration: number;
    is_sync: boolean;
    data: Uint8Array;
  }

  export interface BoxLike {
    write(stream: DataStream): void;
    [key: string]: unknown;
  }

  export interface SampleEntry {
    type?: string;
    avcC?: BoxLike;
    hvcC?: BoxLike;
    esds?: {
      esd?: {
        descs?: Array<{
          tag: number;
          oti?: number;
          descs?: Array<{ tag: number; data?: Uint8Array }>;
        }>;
      };
    };
    [key: string]: unknown;
  }

  export interface Trak {
    mdia: { minf: { stbl: { stsd: { entries: SampleEntry[] } } } };
  }

  export interface MP4File {
    onReady: ((info: MP4Info) => void) | null;
    onError: ((e: string) => void) | null;
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null;
    appendBuffer(buffer: ArrayBuffer & { fileStart: number }): number;
    flush(): void;
    start(): void;
    stop(): void;
    setExtractionOptions(id: number, user?: unknown, opts?: { nbSamples?: number }): void;
    getTrackById(id: number): Trak;
    releaseUsedSamples(id: number, sampleNumber: number): void;
  }

  export class DataStream {
    constructor(arrayBuffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    static LITTLE_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }

  export function createFile(): MP4File;
}
