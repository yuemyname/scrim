/**
 * 모델 자산 경로 — 앱에서 유일하게 네트워크 접근(fetch)이 허용된 파일.
 * ESLint 룰(scrim/no-network)이 이 파일에 한해 '/models/' 리터럴 경로 fetch만 허용한다.
 * 모든 자산은 public/models/ 에 벤더링되어 같은 오리진에서만 로드된다. CDN 없음.
 */

export const WASM_ROOT = '/models/wasm';
export const FACE_MODEL_PATH = '/models/blaze_face_short_range.tflite';

/** 모델 자산이 실제로 서빙되는지 확인한다. 실패 시 UI가 명확한 안내를 띄운다. */
export async function verifyAssets(): Promise<boolean> {
  try {
    const res = await fetch('/models/blaze_face_short_range.tflite', { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
