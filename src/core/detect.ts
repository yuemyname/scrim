/**
 * MediaPipe FaceDetector 래퍼.
 *
 * 임계값을 0.35로 낮게 두는 이유: 비식별화에서는
 * 거짓 양성(안 가려도 될 걸 가림)은 비용이 낮고, 거짓 음성(놓침)은 치명적이다.
 * 이 비대칭 때문에 검출은 관대하게, 노이즈 제거는 트래커(minTrackFrames)에서 한다.
 */
import { FaceDetector } from '@mediapipe/tasks-vision';
import { FACE_MODEL_URL, WASM_BINARY_URL, WASM_LOADER_URL } from './assets';
import type { Box, Detection } from '../types';
import { drawVideoFrame } from './orient';

export interface DetectResult {
  detections: Detection[];
  /** 직전 프레임 대비 화면 변화량 (0..1). 장면 전환(컷) 감지용 */
  cutScore: number;
}

export interface Detector {
  detect(frame: VideoFrame, timestampUs: number): Promise<DetectResult>;
  close(): void;
}

export interface DetectorOptions {
  /** 기본 0.35 — 낮게 잡고 트래커에서 거른다 */
  minConfidence: number;
  /** 기본 512. 군중 원경은 768/1024 "정밀 모드"로 올린다 */
  longSide: number;
  /** 표시 방향 크기와 회전 (분석 캔버스는 표시 방향으로 그린다) */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
}

export async function createDetector(opts: DetectorOptions): Promise<Detector> {
  // WebKit(iPad Safari/Chrome)의 모듈 워커에는 importScripts가 아예 없다.
  // tasks-vision 로더는 typeof importScripts로 워커 여부를 판단하므로, 없으면
  // document.createElement 경로로 빠져 "Can't find variable: document"로 죽는다.
  // TypeError를 던지는 폴리필을 깔아 올바른 폴백(dynamic import)으로 유도한다.
  const g = globalThis as Record<string, unknown>;
  if (typeof g.importScripts !== 'function') {
    g.importScripts = () => {
      throw new TypeError('importScripts is unavailable in module workers');
    };
  }

  // FilesetResolver 대신 수동 fileset: 캐시 무효화 버전 쿼리를 경로에 붙이기 위함.
  // SIMD 변형만 쓴다 — 요구 브라우저(Safari 16.4+/Chrome 94+/Firefox 130+)는 전부 wasm SIMD 지원.
  const fileset = { wasmLoaderPath: WASM_LOADER_URL, wasmBinaryPath: WASM_BINARY_URL };
  const makeDetector = (delegate: 'GPU' | 'CPU'): Promise<FaceDetector> =>
    FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: opts.minConfidence,
      // 캔버스를 명시하지 않으면 tasks-vision이 UA 문자열로 OffscreenCanvas 지원을
      // 추정하는데, iPad Chrome(CriOS) UA에는 Version/ 토큰이 없어 미지원으로 오판하고
      // document.createElement로 빠져 워커에서 죽는다. 명시하면 그 경로를 타지 않는다.
      canvas: new OffscreenCanvas(1, 1),
    });
  // 일부 브라우저(특히 워커 내 WebGL 제약)에서 GPU 델리게이트가 실패한다 → CPU 폴백
  const detector = await makeDetector('GPU').catch(() => makeDetector('CPU'));

  // 다운스케일 후 검출: 1080p 원본 그대로 넣으면 3~4배 느리고 정확도 이득이 거의 없다.
  const scale = Math.min(1, opts.longSide / Math.max(opts.displayWidth, opts.displayHeight));
  const cw = Math.max(2, Math.round(opts.displayWidth * scale));
  const ch = Math.max(2, Math.round(opts.displayHeight * scale));
  // 캔버스는 재사용한다 (프레임마다 생성 금지 — 성능 예산)
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('OffscreenCanvas 2D 컨텍스트를 만들 수 없습니다');

  let lastTsMs = -1;

  // 장면 전환 감지용 저해상도 서명 (16×16 썸네일 평균 차이)
  const THUMB = 16;
  const thumbCanvas = new OffscreenCanvas(THUMB, THUMB);
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;
  let prevThumb: Uint8ClampedArray | null = null;

  return {
    async detect(frame: VideoFrame, timestampUs: number): Promise<DetectResult> {
      await drawVideoFrame(ctx, frame, opts.rotation, cw, ch);

      // 컷 스코어: 이전 프레임 썸네일과의 평균 절대 차이 (0..1)
      thumbCtx.imageSmoothingEnabled = true;
      thumbCtx.drawImage(canvas, 0, 0, cw, ch, 0, 0, THUMB, THUMB);
      const thumb = thumbCtx.getImageData(0, 0, THUMB, THUMB).data;
      let cutScore = 0;
      if (prevThumb) {
        let sum = 0;
        for (let i = 0; i < thumb.length; i += 4) {
          sum += Math.abs((thumb[i] ?? 0) - (prevThumb[i] ?? 0));
          sum += Math.abs((thumb[i + 1] ?? 0) - (prevThumb[i + 1] ?? 0));
          sum += Math.abs((thumb[i + 2] ?? 0) - (prevThumb[i + 2] ?? 0));
        }
        cutScore = sum / (THUMB * THUMB * 3 * 255);
      }
      prevThumb = new Uint8ClampedArray(thumb);

      // detectForVideo의 타임스탬프는 단조 증가여야 한다
      let tsMs = timestampUs / 1000;
      if (tsMs <= lastTsMs) tsMs = lastTsMs + 0.001;
      lastTsMs = tsMs;

      const result = detector.detectForVideo(canvas as unknown as HTMLCanvasElement, tsMs);
      const out: Detection[] = [];
      for (const d of result.detections) {
        const bb = d.boundingBox;
        if (!bb) continue;
        const box: Box = {
          x: bb.originX / cw,
          y: bb.originY / ch,
          w: bb.width / cw,
          h: bb.height / ch,
        };
        if (box.w <= 0 || box.h <= 0) continue;
        out.push({ box, score: d.categories[0]?.score ?? 0 });
      }
      return { detections: out, cutScore };
    },
    close(): void {
      detector.close();
    },
  };
}
