/**
 * 모델 자산 경로 — 앱에서 유일하게 네트워크 접근(fetch)이 허용된 파일.
 * ESLint 룰(scrim/no-network)이 이 파일에 한해 자체 배포 경로의 models/ fetch만 허용한다.
 * 모든 자산은 public/models/ 에 벤더링되어 같은 오리진에서만 로드된다. CDN 없음.
 *
 * BASE_URL은 빌드 시 Vite가 정적으로 치환한다 (기본 '/', GitHub Pages 배포 시 '/scrim/').
 * 워커 청크에도 절대 경로로 새겨지므로 어디서 로드하든 같은 자산을 가리킨다.
 */

export const WASM_ROOT = `${import.meta.env.BASE_URL}models/wasm`;
export const FACE_MODEL_PATH = `${import.meta.env.BASE_URL}models/blaze_face_short_range.tflite`;

/** 고정 경로 자산은 배포 후에도 브라우저 캐시가 남는다 — 빌드 버전 쿼리로 무효화 */
export const ASSET_VERSION = __BUILD_ID__;
export const WASM_LOADER_URL = `${WASM_ROOT}/vision_wasm_internal.js?v=${ASSET_VERSION}`;
export const WASM_BINARY_URL = `${WASM_ROOT}/vision_wasm_internal.wasm?v=${ASSET_VERSION}`;
export const FACE_MODEL_URL = `${FACE_MODEL_PATH}?v=${ASSET_VERSION}`;
/** onnxruntime wasm 런타임 경로 (YuNet 엔진용) */
export const ORT_WASM_ROOT = `${import.meta.env.BASE_URL}models/ort/`;
export const YUNET_MODEL_URL = `${import.meta.env.BASE_URL}models/yunet.onnx?v=${ASSET_VERSION}`;

/** 모델 자산이 실제로 서빙되는지 확인한다. 실패 시 UI가 명확한 안내를 띄운다. */
export async function verifyAssets(): Promise<boolean> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}models/blaze_face_short_range.tflite`, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
