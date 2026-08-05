/**
 * YuNet 얼굴 검출 모델과 onnxruntime-web wasm 런타임을 public/models/ 에 벤더링한다.
 * 앱 자체는 어떤 CDN에도 접근하지 않는다 — 이 스크립트는 빌드 준비 단계에서만 실행된다.
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(root, '..');
const outDir = path.join(projectRoot, 'public/models');

await mkdir(outDir, { recursive: true });

// YuNet 얼굴 검출 모델 (OpenCV Zoo, MIT)
const yunetUrl =
  'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx';
const yunetOut = path.join(outDir, 'yunet.onnx');
try {
  await access(yunetOut);
  console.log('yunet model already present, skipping download');
} catch {
  const res = await fetch(yunetUrl);
  if (!res.ok || !res.body) throw new Error(`yunet download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(yunetOut));
  console.log('downloaded yunet.onnx');
}

// onnxruntime-web wasm 런타임
await mkdir(path.join(outDir, 'ort'), { recursive: true });
const ortDist = path.join(projectRoot, 'node_modules/onnxruntime-web/dist');
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await cp(path.join(ortDist, f), path.join(outDir, 'ort', f));
}
console.log('copied onnxruntime-web wasm runtime');
