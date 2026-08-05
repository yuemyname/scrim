/**
 * YuNet 얼굴 검출기 (OpenCV Zoo face_detection_yunet_2023mar, MIT).
 *
 * BlazeFace short-range가 셀피 거리 전용인 것과 달리 YuNet은 작은 얼굴·군중에
 * 강해 거리 촬영 소스의 기본 엔진으로 쓴다. onnxruntime-web(wasm)으로 실행하며
 * 런타임·모델 모두 자체 오리진(/models/)에서 로드된다. CDN 없음.
 *
 * 후처리는 OpenCV FaceDetectorYN과 동일:
 *   stride ∈ {8,16,32}, score = sqrt(cls·obj),
 *   cx=(col+dx)·s, cy=(row+dy)·s, w=exp(dw)·s, h=exp(dh)·s → NMS
 */
import * as ort from 'onnxruntime-web/wasm';
import { ORT_WASM_ROOT, YUNET_MODEL_URL } from './assets';
import type { Detection } from '../types';
import type { Detector, DetectorOptions, DetectResult } from './detect';
import { drawVideoFrame } from './orient';
import { nms } from './track';

const STRIDES = [8, 16, 32] as const;

export async function createYunetDetector(opts: DetectorOptions): Promise<Detector> {
  ort.env.wasm.wasmPaths = ORT_WASM_ROOT;
  // COOP/COEP 없이 동작해야 한다 (GitHub Pages 등 정적 호스팅) — 단일 스레드
  ort.env.wasm.numThreads = 1;

  const session = await ort.InferenceSession.create(YUNET_MODEL_URL, {
    executionProviders: ['wasm'],
  });
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('YuNet: 입력 텐서를 찾을 수 없습니다');

  // 2023mar onnx는 입력이 640×640 고정이다 — 비율 유지 레터박스로 맞춘다
  const inW = 640;
  const inH = 640;
  const scale = Math.min(inW / opts.displayWidth, inH / opts.displayHeight);
  const dw = Math.max(2, Math.round(opts.displayWidth * scale));
  const dh = Math.max(2, Math.round(opts.displayHeight * scale));

  const canvas = new OffscreenCanvas(inW, inH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D 컨텍스트를 만들 수 없습니다');
  const input = new Float32Array(3 * inW * inH);

  // YuNet 점수 분포는 BlazeFace보다 높은 쪽에 몰려 있다 — 앱의 민감도(0.35/0.5/0.65)를
  // YuNet 권장 대역(0.55/0.7/0.85)으로 사상한다
  const threshold = Math.min(0.95, opts.minConfidence + 0.2);

  // 장면 전환 감지용 저해상도 서명
  const THUMB = 16;
  const thumbCanvas = new OffscreenCanvas(THUMB, THUMB);
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;
  let prevThumb: Uint8ClampedArray | null = null;

  return {
    async detect(frame: VideoFrame, _timestampUs: number): Promise<DetectResult> {
      // 프레임을 표시 방향으로 (0,0,dw,dh)에 그린다. 남는 영역은 검정 패딩.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, inW, inH);
      await drawVideoFrame(ctx, frame, opts.rotation, dw, dh);

      // 컷 스코어
      thumbCtx.imageSmoothingEnabled = true;
      thumbCtx.drawImage(canvas, 0, 0, dw, dh, 0, 0, THUMB, THUMB);
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

      // RGBA → NCHW BGR(0..255, 정규화 없음 — OpenCV blobFromImage와 동일)
      const rgba = ctx.getImageData(0, 0, inW, inH).data;
      const plane = inW * inH;
      for (let i = 0; i < plane; i++) {
        input[i] = rgba[i * 4 + 2] ?? 0; // B
        input[plane + i] = rgba[i * 4 + 1] ?? 0; // G
        input[2 * plane + i] = rgba[i * 4] ?? 0; // R
      }

      const tensor = new ort.Tensor('float32', input, [1, 3, inH, inW]);
      const outputs = await session.run({ [inputName]: tensor });

      const detections: Detection[] = [];
      for (const s of STRIDES) {
        const cls = pick(outputs, 'cls', s);
        const obj = pick(outputs, 'obj', s);
        const bbox = pick(outputs, 'bbox', s);
        if (!cls || !obj || !bbox) continue;
        const cols = inW / s;
        const n = cls.length;
        for (let idx = 0; idx < n; idx++) {
          const score = Math.sqrt(clamp01(cls[idx] ?? 0) * clamp01(obj[idx] ?? 0));
          if (score < threshold) continue;
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          const cx = (col + (bbox[idx * 4] ?? 0)) * s;
          const cy = (row + (bbox[idx * 4 + 1] ?? 0)) * s;
          const bw = Math.exp(bbox[idx * 4 + 2] ?? 0) * s;
          const bh = Math.exp(bbox[idx * 4 + 3] ?? 0) * s;
          const box = {
            x: (cx - bw / 2) / dw,
            y: (cy - bh / 2) / dh,
            w: bw / dw,
            h: bh / dh,
          };
          if (box.w <= 0 || box.h <= 0 || box.x > 1 || box.y > 1) continue;
          detections.push({ box, score });
        }
      }

      return { detections: nms(detections, 0.45), cutScore };
    },
    close(): void {
      void session.release();
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 출력 이름은 빌드에 따라 'cls_8' / 'cls8' 등으로 다를 수 있어 정확 일치 우선, 느슨 매칭 폴백 */
function pick(outputs: Record<string, ort.Tensor>, kind: string, stride: number): Float32Array | null {
  const exact = outputs[`${kind}_${stride}`];
  if (exact && exact.data instanceof Float32Array) return exact.data;
  for (const name of Object.keys(outputs)) {
    if (name.includes(kind) && name.endsWith(String(stride))) {
      const t = outputs[name];
      if (t && t.data instanceof Float32Array) return t.data;
    }
  }
  return null;
}
