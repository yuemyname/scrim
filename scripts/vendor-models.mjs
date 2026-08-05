/**
 * MediaPipe wasm 런타임과 얼굴 검출 모델을 public/models/ 에 벤더링한다.
 * 앱 자체는 어떤 CDN에도 접근하지 않는다 — 이 스크립트는 빌드 준비 단계에서만 실행된다.
 *
 * wasm: node_modules/@mediapipe/tasks-vision/wasm 에서 복사 (버전 고정)
 * 모델: MediaPipe 공개 모델 저장소에서 1회 다운로드
 */
import { cp, mkdir, access, readFile, writeFile, readdir } from 'node:fs/promises';
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

// 패치: tasks-vision은 모듈 워커에서 로더를 dynamic import로 불러오는데,
// UMD 로더는 그 경우 전역 ModuleFactory를 설정하지 않아 "ModuleFactory not set"이 난다.
// 로더 끝에 전역 등록을 덧붙여 모듈/클래식 어느 로드 방식에서도 동작하게 한다.
const PATCH =
  '\n// scrim patch: 모듈 워커에서 dynamic import로 로드될 때도 전역 등록 (tasks-vision 로더 호환)\n' +
  '// 이 로더는 클래식 스크립트(sloppy mode) 전제로 작성되어 모듈(strict mode)에서 두 가지가 깨진다:\n' +
  '// 1) var ModuleFactory가 전역이 되지 않음  2) 블록 안 함수 선언 custom_dbg가 블록 밖에서 참조됨\n' +
  'if (typeof ModuleFactory !== "undefined") {\n' +
  '  globalThis.ModuleFactory = ModuleFactory;\n' +
  '  globalThis.__scrimModuleFactory = ModuleFactory;\n' +
  '}\n' +
  'if (typeof globalThis.custom_dbg === "undefined") {\n' +
  '  globalThis.custom_dbg = function () { console.warn.apply(console, arguments); };\n' +
  '}\n';
for (const name of await readdir(path.join(outDir, 'wasm'))) {
  if (!name.endsWith('.js')) continue;
  const p = path.join(outDir, 'wasm', name);
  const src = await readFile(p, 'utf8');
  if (!src.includes('scrim patch')) {
    await writeFile(p, src + PATCH);
    console.log(`patched ${name} (global ModuleFactory registration)`);
  }
}

try {
  await access(modelOut);
  console.log('model already present, skipping download');
} catch {
  const res = await fetch(modelUrl);
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(modelOut));
  console.log('downloaded blaze_face_short_range.tflite');
}
