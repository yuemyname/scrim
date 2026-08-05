/**
 * 얼굴 검출 인터페이스. 구현은 YuNet (yunet.ts) 하나다.
 *
 * 임계값을 낮게 두는 이유: 비식별화에서는 거짓 양성(안 가려도 될 걸 가림)은
 * 비용이 낮고, 거짓 음성(놓침)은 치명적이다. 이 비대칭 때문에 검출은 관대하게,
 * 노이즈 제거는 트래커(minTrackFrames)에서 한다.
 */
import type { Detection } from '../types';

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
  /** 기본 0.35 — 낮게 잡고 트래커에서 거른다 (YuNet 점수 대역으로 내부 사상) */
  minConfidence: number;
  /** 표시 방향 크기와 회전 (분석 캔버스는 표시 방향으로 그린다) */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
}

export async function createDetector(opts: DetectorOptions): Promise<Detector> {
  const { createYunetDetector } = await import('./yunet');
  return createYunetDetector(opts);
}
