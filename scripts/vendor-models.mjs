/**
 * MediaPipe wasm 런타임과 얼굴 검출 모델을 public/models/ 에 벤더링한다.
 * 앱 자체는 어떤 CDN에도 접근하지 않는다 — 이 스크립트는 빌드 준비 단계에서만 실행된다.
 *
 * wasm: node_modules/@mediapipe/tasks-vision/wasm 에서 복사 (버전 고정)
 * 모델: MediaPipe 공개 모델 저장소에서 1회 다운로드
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(root, '..');
const wasmSrc = path.join(projectRoot, 'node_modules/@mediapipe/tasks-vision/wasm');
const outDir = path.join(projectRoot, 'public/models');
const modelUrl =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
const modelOut = path.join(outDir, 'blaze_face_short_range.tflite');

await mkdir(path.join(outDir, 'wasm'), { recursive: true });
await cp(wasmSrc, path.join(outDir, 'wasm'), { recursive: true });
console.log('copied wasm runtime from @mediapipe/tasks-vision');

try {
  await access(modelOut);
  console.log('model already present, skipping download');
} catch {
  const res = await fetch(modelUrl);
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(modelOut));
  console.log('downloaded blaze_face_short_range.tflite');
}
