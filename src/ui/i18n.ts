/**
 * 한국어/영어 전환. 외부 라이브러리 없이 사전 + t() 함수 하나로 처리한다.
 * 선택은 localStorage에 저장되고, 최초 기본값은 브라우저 언어를 따른다.
 */
export type Lang = 'ko' | 'en';

const STORAGE_KEY = 'scrim-lang';

function initLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    /* localStorage 불가 환경 */
  }
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

let lang: Lang = initLang();

export function currentLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* noop */
  }
}

const M = {
  open: { ko: '영상·사진 열기', en: 'Open video/photo' },
  // 컬러 이모지 그대로 노출한다 (VS15로 흑백화하지 않음) — DESIGN.md §8
  // 이모지 규칙의 확정된 예외. U+2615는 기본이 이모지 프레젠테이션이라
  // 변이 선택자 없이도 애플 커피 이모지로 렌더링된다.
  support: { ko: '☕ 후원', en: '☕ Support' },
  supportTip: {
    ko: '이 도구가 도움이 됐다면 제작자를 후원해 주세요 (새 창)',
    en: 'If this tool helped you, consider supporting the developer (opens new tab)',
  },
  saveWork: { ko: '작업 내역 저장', en: 'Save work' },
  saveWorkTip: {
    ko: '가림 박스·스타일 등 편집 내역만 저장합니다. 영상 파일은 포함되지 않습니다.',
    en: 'Saves only your edits (boxes, styles). The media file itself is not included.',
  },
  loadWork: { ko: '작업 내역 불러오기', en: 'Load work' },
  loadWorkTip: {
    ko: '이 영상에서 저장했던 편집 내역(.json)을 불러옵니다.',
    en: 'Load previously saved edits (.json) for this media.',
  },
  export: { ko: '내보내기', en: 'Export' },
  hazardCount: { ko: '미검증 구간 {n}개', en: '{n} unverified' },
  allVerified: { ko: '모든 구간 확인됨', en: 'All verified' },
  dropLine1: { ko: '영상이나 사진을 끌어다 놓으세요.', en: 'Drop a video or photo here.' },
  dropLine2: { ko: '파일은 이 브라우저를 벗어나지 않습니다.', en: 'Files never leave this browser.' },
  sensitivity: { ko: '검출 민감도', en: 'Detection sensitivity' },
  senseSensitive: { ko: '민감 — 놓침 최소 (기본)', en: 'Sensitive — fewest misses (default)' },
  senseStandard: { ko: '표준', en: 'Standard' },
  senseConservative: { ko: '보수 — 잘못 가림 최소', en: 'Conservative — fewest false covers' },
  privacyLine: { ko: '이 영상은 브라우저 밖으로 나가지 않습니다', en: 'Your media never leaves this browser' },
  privacyP1: {
    ko: '모든 처리(디코딩·얼굴 검출·모자이크·인코딩)는 이 기기의 브라우저 안에서만 실행됩니다. 서버 업로드가 없고, 계정도 없습니다.',
    en: 'All processing (decoding, face detection, redaction, encoding) runs entirely inside your browser. No uploads, no accounts.',
  },
  privacyP2: {
    ko: '얼굴 검출 모델도 이 사이트에 함께 내장되어 있어 외부 CDN에 접근하지 않습니다. 첫 로드 이후에는 완전히 오프라인으로 동작합니다.',
    en: 'The face-detection model is bundled with this site — no external CDNs. After the first load it works fully offline.',
  },
  privacyP3: {
    ko: '직접 확인할 수 있습니다: 개발자도구(F12)의 네트워크 탭을 열어 두고 영상을 처리해 보세요. 네트워크 요청이 발생하지 않습니다. 페이지의 Content-Security-Policy가 외부 연결 자체를 차단합니다.',
    en: 'You can verify this yourself: open the browser DevTools Network tab while processing — no requests are made. The page CSP blocks outbound connections entirely.',
  },
  ok: { ko: '확인', en: 'OK' },
  cancel: { ko: '취소', en: 'Cancel' },
  play: { ko: '재생', en: 'Play' },
  pause: { ko: '일시정지', en: 'Pause' },
  prevFrame: { ko: '이전 프레임 (←)', en: 'Previous frame (←)' },
  nextFrame: { ko: '다음 프레임 (→)', en: 'Next frame (→)' },
  undo: { ko: '되돌리기', en: 'Undo' },
  redo: { ko: '다시 실행', en: 'Redo' },
  undone: { ko: '되돌렸습니다', en: 'Undone' },
  nothingToUndo: { ko: '되돌릴 작업이 없습니다', en: 'Nothing to undo' },
  redone: { ko: '다시 실행했습니다', en: 'Redone' },
  nothingToRedo: { ko: '다시 실행할 작업이 없습니다', en: 'Nothing to redo' },
  trackFace: { ko: '얼굴 추적', en: 'Track face' },
  trackFaceTip: {
    ko: '선택한 수동 박스의 대상을 구간 동안 자동으로 따라갑니다',
    en: 'Automatically follow the selected manual box across its range',
  },
  tracking: { ko: '추적 중', en: 'Tracking' },
  trackNeedManual: {
    ko: '먼저 수동으로 그린 박스를 선택하세요',
    en: 'Select a manually drawn box first',
  },
  trackDone: {
    ko: '추적 완료 — {n}개 프레임에서 얼굴을 찾았습니다',
    en: 'Tracking done — face found on {n} frames',
  },
  trackFail: { ko: '추적에 실패했습니다: {msg}', en: 'Tracking failed: {msg}' },
  trackNoFrames: {
    ko: '구간에서 프레임을 읽지 못해 추적 결과가 없습니다',
    en: 'No frames could be read in this range — nothing tracked',
  },
  trackCancelled: { ko: '추적을 취소했습니다', en: 'Tracking cancelled' },
  cutMark: { ko: '컷 표시', en: 'Mark cut' },
  cutTip: {
    ko: '현재 위치에 장면 경계 마커 추가/삭제 (C)',
    en: 'Add/remove a scene-cut marker at the playhead (C)',
  },
  cutAdded: { ko: '컷 마커를 추가했습니다', en: 'Cut marker added' },
  cutRemoved: { ko: '컷 마커를 삭제했습니다', en: 'Cut marker removed' },
  noHazard: { ko: '미검증 구간이 없습니다', en: 'No unverified segments' },
  deletedTracks: { ko: '트랙 {n}개를 삭제했습니다', en: 'Deleted {n} track(s)' },
  stripHint: {
    ko: '<kbd>N</kbd> 다음 미검증 구간 · 사선 구간은 얼굴을 찾지 못한 프레임입니다',
    en: '<kbd>N</kbd> next unverified · striped = frames where no face was found',
  },
  analyzing: { ko: '분석 중', en: 'Analyzing' },
  exporting: { ko: '내보내는 중', en: 'Exporting' },
  phaseDemux: { ko: '영상을 읽는 중', en: 'Reading media' },
  phaseAnalyze: { ko: '얼굴을 찾는 중', en: 'Finding faces' },
  phaseRender: { ko: '가림을 적용하는 중', en: 'Applying covers' },
  phaseMux: { ko: '파일을 만드는 중', en: 'Writing file' },
  preparing: { ko: '준비 중', en: 'Preparing' },
  etaSec: { ko: '약 {s}초 남음', en: '~{s}s left' },
  etaMin: { ko: '약 {m}분 {s}초 남음', en: '~{m}m {s}s left' },
  cannotOpen: { ko: '파일을 열 수 없습니다', en: 'Could not open file' },
  exportFailedTitle: { ko: '내보내기에 실패했습니다', en: 'Export failed' },
  exportFailed: { ko: '내보내기 실패: {msg}', en: 'Export failed: {msg}' },
  exported: { ko: '내보냈습니다', en: 'Exported' },
  exportCancelled: { ko: '내보내기를 취소했습니다', en: 'Export cancelled' },
  analysisCancelled: { ko: '분석을 취소했습니다.', en: 'Analysis cancelled.' },
  resolution: { ko: '해상도', en: 'Resolution' },
  original: { ko: '원본', en: 'Original' },
  warn4k: {
    ko: '원본(4K) 그대로 내보내면 기기에 따라 시간이 오래 걸리거나 메모리 부족으로 실패할 수 있습니다.',
    en: 'Exporting at original 4K may be slow or fail from memory pressure on some devices.',
  },
  longVideoWarn: {
    ko: '5분이 넘는 영상입니다. 처리 시간이 길어질 수 있으니 구간을 나눠 작업하는 것을 권합니다.',
    en: 'This video is over 5 minutes. Consider working in shorter segments.',
  },
  modelLoadFail: {
    ko: '얼굴 검출 모델을 불러올 수 없습니다. 페이지를 새로 고침해 주세요.',
    en: 'Could not load the face-detection model. Please refresh the page.',
  },
  bgSlow: {
    ko: '백그라운드에서 처리가 느려졌을 수 있습니다. 탭을 열어 둔 채 기다려 주세요.',
    en: 'Processing may slow down in background tabs. Keep this tab open.',
  },
  workSaved: { ko: '작업 내역을 저장했습니다', en: 'Work saved' },
  workLoaded: { ko: '작업 내역을 불러왔습니다', en: 'Work loaded' },
  loadFailed: { ko: '불러오기에 실패했습니다.', en: 'Failed to load.' },
  projUnreadable: { ko: '작업 파일을 읽을 수 없습니다.', en: 'Could not read the work file.' },
  projBadFormat: { ko: '작업 파일 형식이 아닙니다.', en: 'Not a valid work file.' },
  projMismatch: {
    ko: '다른 영상의 작업 내역입니다 ({name}). 같은 영상을 연 상태에서 불러오세요.',
    en: 'This work file belongs to a different media file ({name}).',
  },
  unsupportedBrowser: {
    ko: '이 브라우저는 영상 처리 기능(WebCodecs)을 지원하지 않습니다.<br />Safari 16.4+, Chrome 94+, Firefox 130+ 에서 열어 주세요.',
    en: 'This browser does not support WebCodecs video processing.<br />Please use Safari 16.4+, Chrome 94+, or Firefox 130+.',
  },
  selectAll: { ko: '전체 선택', en: 'Select all' },
  deselectAll: { ko: '전체 해제', en: 'Clear all' },
  nSelected: { ko: '{n}개 선택', en: '{n} selected' },
  turnOff: { ko: '끄기', en: 'Off' },
  turnOn: { ko: '켜기', en: 'On' },
  delete: { ko: '삭제', en: 'Delete' },
  manualTag: { ko: '수동', en: 'manual' },
  lowConfTip: {
    ko: '신뢰도가 낮습니다 — 오검출인지 확인하세요',
    en: 'Low confidence — check for a false detection',
  },
  emptyNote: {
    ko: '얼굴을 찾지 못했습니다. 화면 위에서 드래그해 수동으로 지정하세요.',
    en: 'No faces found. Drag on the frame to add covers manually.',
  },
  batchEditing: { ko: '{n}개 트랙 일괄 수정', en: 'Editing {n} tracks' },
  trackStyleCustom: { ko: '{id} 트랙 스타일 (개별)', en: '{id} style (custom)' },
  trackStyleInherit: { ko: '{id} 트랙 스타일 (전체 상속)', en: '{id} style (inherited)' },
  globalStyleLabel: { ko: '전체 스타일', en: 'Global style' },
  kind: { ko: '종류', en: 'Type' },
  strength: { ko: '강도', en: 'Strength' },
  margin: { ko: '여백', en: 'Margin' },
  feather: { ko: '페더', en: 'Feather' },
  shape: { ko: '모양', en: 'Shape' },
  content: { ko: '내용', en: 'Text' },
  mosaic: { ko: '모자이크', en: 'Mosaic' },
  blur: { ko: '블러', en: 'Blur' },
  sticker: { ko: '스티커', en: 'Sticker' },
  blurTip: {
    ko: '블러는 반경이 작으면 복원될 수 있어 최소 강도가 강제됩니다',
    en: 'Weak blur can be reversed — a minimum strength is enforced',
  },
  stickerTip: {
    ko: '이모지/문구가 영역을 덮습니다 (바탕은 평균색 면)',
    en: 'Emoji/text covers the area (flat average-color base)',
  },
  ellipse: { ko: '타원', en: 'Ellipse' },
  rect: { ko: '사각', en: 'Rect' },
  resetBatch: { ko: '선택 트랙들 전체 스타일로 되돌리기', en: 'Reset selected to global style' },
  resetOne: { ko: '전체 스타일로 되돌리기', en: 'Reset to global style' },
  stickerPlaceholder: { ko: '🙂 또는 문구', en: '🙂 or text' },
  boxDelete: { ko: '✕ 삭제', en: '✕ Delete' },
  dotOnTip: { ko: '가림 켜짐 — 누르면 끕니다', en: 'Cover on — tap to turn off' },
  dotOffTip: { ko: '가림 꺼짐 — 누르면 켭니다', en: 'Cover off — tap to turn on' },
  checkTip: { ko: '일괄 수정 대상으로 선택', en: 'Select for batch editing' },
  trackDeleteTip: { ko: '트랙 삭제', en: 'Delete track' },
} as const;

export type MsgKey = keyof typeof M;

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = M[key][lang];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
