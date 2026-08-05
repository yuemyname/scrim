/** 앱 표시명. 프로젝트명은 package.json의 name과 이 상수만 참조한다. */
export const APP_NAME = 'scrim';

/** 정규화 좌표 (0..1). 소스 해상도 변경에 독립적이어야 한다.
 *  좌표계는 항상 "표시 방향"(회전 적용 후) 기준이다. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection {
  box: Box;
  score: number;
}

export type SampleSource = 'detected' | 'interpolated' | 'held' | 'manual';

export interface TrackSample {
  /** 마이크로초. VideoFrame.timestamp와 동일 단위 */
  t: number;
  box: Box;
  source: SampleSource;
}

export type ShapeKind = 'ellipse' | 'rect';
export type RedactKind = 'mosaic' | 'solid' | 'blur' | 'sticker';

export interface RedactStyle {
  kind: RedactKind;
  /** mosaic: 셀 크기(박스 대비 비율). blur: 반경. solid: 무시 */
  strength: number;
  shape: ShapeKind;
  /** 경계 페더 (0..1, 박스 짧은 변 대비) */
  feather: number;
  /** 박스 확대 배율. 이마·턱·머리카락까지 덮기 위해 기본 1.4 */
  scale: number;
  /** kind='sticker'일 때 표시할 이모지/문구. 모자이크 바탕 위에 그려진다 */
  sticker?: string;
}

export interface Track {
  id: string;
  samples: TrackSample[]; // t 오름차순 정렬 보장
  enabled: boolean;
  /** null이면 globalStyle 상속 */
  style: RedactStyle | null;
  origin: 'auto' | 'manual';
  /** 자동 트랙의 평균 검출 신뢰도 (0..1). 낮으면 오검출 의심 — 리뷰 UI 표시용 */
  avgScore?: number;
}

export interface SourceMeta {
  fileName: string;
  /** 표시 방향 기준 (rotation 적용 후) */
  width: number;
  height: number;
  durationUs: number;
  frameCount: number;
  /** mp4 matrix에서 유도. 0 | 90 | 180 | 270 */
  rotation: number;
  codec: string;
  hasAudio: boolean;
}

export interface Project {
  version: 1;
  source: SourceMeta;
  tracks: Track[];
  globalStyle: RedactStyle;
}

/** 분석 패스가 남기는 프레임 단위 색인. 검증 스트립의 원천 데이터. */
export interface FrameIndex {
  /** presentation 순서 오름차순, 마이크로초 */
  timestampsUs: number[];
  /** 트래킹 이전의 원시 검출 개수 (프레임별) */
  detectionCounts: number[];
  /** minTrackFrames 미만으로 폐기된 짧은 검출의 발생 시각 */
  discardedShortAt: number[];
  /** 장면 전환(컷) 프레임 타임스탬프 — 타임라인 마커·스냅용 */
  cutsUs: number[];
}

export interface Progress {
  phase: 'demux' | 'analyze' | 'render' | 'mux';
  done: number;
  total: number;
  etaMs: number;
}

export const DEFAULT_STYLE: RedactStyle = {
  kind: 'mosaic',
  strength: 0.12,
  shape: 'ellipse',
  feather: 0.25,
  scale: 1.4,
};

/** blur는 반경이 작으면 복원 공격이 가능하다 — 하한을 강제한다 (px, 박스 짧은 변 대비 최소 비율은 redact.ts에서 추가 적용) */
export const MIN_BLUR_RADIUS = 12;
