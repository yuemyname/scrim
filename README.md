# scrim

브라우저 안에서만 동작하는 영상·사진 얼굴 비식별화 도구.
업로드 없음. 서버 없음. 파일은 사용자 기기를 떠나지 않는다.

시위·집회·거리 촬영본처럼 동의 없이 찍힌 시민이 다수 등장하는 영상을 공개 전에 비식별화한다.
핵심 가치는 검출 성능이 아니라 **놓친 구간을 사용자에게 드러내고 손으로 덮게 하는 리뷰 루프**다.

배포: 푸시하면 GitHub Pages로 자동 배포된다 (`.github/workflows/pages.yml`).

## 기능

- **얼굴 검출**: YuNet (OpenCV Zoo `face_detection_yunet_2023mar`, MIT) + onnxruntime-web(wasm).
  검출 → IoU 트래킹 → 스무딩/보간 → 장면 전환(컷) 경계에서 트랙 분리.
- **리뷰 루프**: 프레임 단위 검증 스트립 — 얼굴을 못 찾은 구간은 사선으로 표시되고
  `N` 키로 순회한다. 미검증 카운터가 0이 될 때까지 확인하는 흐름.
- **수동 박스**: 드래그하면 항상 새 박스가 생긴다 (기존 가림 위에도 겹침 레이어).
  탭 = 선택, 선택된 박스 드래그 = 이동, 모서리 = 크기 조절. 키프레임 보간.
- **얼굴 추적**: 수동 박스를 선택하고 '얼굴 추적'을 누르면 구간을 다시 디코드하며
  박스 주변 확대 재검출 + 템플릿 매칭으로 대상을 따라간다 (검출이 놓친 얼굴용).
- **가림 스타일**: 모자이크 / 블러(복원 방지 하한 강제) / 스티커(이모지·문구가 영역을
  덮고 바탕은 평균색 면). 트랙별 개별 스타일, 다중 선택 일괄 수정.
- **타임라인**: 트랙 구간 핸들 드래그(컷 스냅), 수동 컷 마커(`C`), 되돌리기/다시 실행.
- **사진 모드**: JPEG/PNG/WebP 등 단일 이미지도 같은 흐름으로 처리.
- **작업 내역 저장/불러오기**: 편집 내역만 JSON으로 저장 (미디어 파일 미포함).
- **한국어/영어** 전환 (상단바 토글).
- **PWA**: iPad Safari에서 공유 → 홈 화면에 추가하면 전체 화면 앱으로 실행되고,
  서비스 워커가 자산(모델 wasm 포함)을 캐시해 오프라인에서도 동작한다.
- **후원 버튼**: `src/types.ts`의 `SUPPORT_URL`에 후원 페이지 링크를 넣으면
  상단바에 후원 버튼이 표시된다 (비어 있으면 숨김).

## 시작하기

```sh
pnpm install
pnpm vendor:models   # YuNet onnx + onnxruntime wasm을 public/models/ 에 벤더링
pnpm dev
```

`public/models/` 가 채워져 있으면 첫 로드 이후 완전히 오프라인으로 동작한다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm dev` | 개발 서버 |
| `pnpm build` | 타입 체크 + 프로덕션 빌드 |
| `pnpm lint` | ESLint (네트워크 API 금지 룰 포함) |
| `pnpm vendor:models` | 모델 자산 벤더링 (빌드 준비 1회) |

## 구조

```
src/
  types.ts            # 전 모듈이 공유하는 타입 (정규화 좌표 규칙)
  core/
    assets.ts         # 모델 경로 — 유일한 fetch 허용 파일 (/models/ 한정)
    demux.ts          # mp4box.js → EncodedVideoChunk, 오디오 무손실 추출, 회전 유도
    decode.ts         # WebCodecs 디코드 스트림 (백프레셔, 설정 변형 재시도)
    detect.ts         # 검출기 인터페이스 (YuNet 로더)
    yunet.ts          # YuNet 추론 + 후처리, 영역(크롭) 검출기
    track.ts          # IoU 트래킹 + EMA 스무딩 + hold/보간 + 컷 경계 분리
    regiontrack.ts    # 수동 박스 얼굴 추적 (확대 재검출 + SAD 템플릿 매칭)
    redact.ts         # 모자이크/블러/스티커 합성 (blur 하한 강제, 알 수 없는 값은 모자이크 폴백)
    encode.ts         # VideoEncoder + mp4-muxer (해상도별 H.264 레벨, 오디오 패스스루)
    pipeline.ts       # 2-패스: analyze / analyzeImage / render (실패 시 보수 설정 재시도)
  worker/             # 분석·렌더·추적 전용 Worker
  ui/                 # 플레이어, 타임라인, 검증 스트립, 트랙/스타일 패널, i18n
```

## 디자인

UI는 루트의 `DESIGN.md`(null8 디자인 시스템)를 따른다 — 웜 오프화이트 배경의
모노크롬 계측 장비 룩, 모노스페이스 폰트, 상태는 색이 아니라 반전과 점멸로 표현,
수치는 LCD 칩. 컬러는 신호로만 쓴다. 예외로 비디오 위 트랙 구분 색은 기능 신호로 유지.

## 개인정보 보장

- 모든 처리(디코딩·검출·합성·인코딩)는 브라우저 안에서 실행된다.
- YuNet 모델과 onnxruntime wasm은 CDN이 아니라 `public/models/` 에서 로드된다.
- `index.html` 의 CSP가 외부 연결을 차단한다 (`connect-src 'self'`).
- ESLint 커스텀 룰(`scrim/no-network`)이 `src/` 전역에서 `fetch`/`XMLHttpRequest`/`sendBeacon`/`WebSocket`/`EventSource` 사용을 금지한다. 예외는 `src/core/assets.ts` 하나뿐이며 `/models/` 경로만 허용된다.
- 가림이 "사라지는" 코드 경로를 만들지 않는다 — 알 수 없는 스타일 값은 모자이크로 폴백.
- 서비스 워커(`public/sw.js`)는 같은 오리진 자산의 캐시·재검증만 한다 — 외부 요청 없음.
- 개발자도구 네트워크 탭으로 직접 검증할 수 있다.

## 브라우저 요구사항

WebCodecs(`VideoDecoder`/`VideoEncoder`), `OffscreenCanvas`, 모듈 Worker.
Safari 16.4+, Chrome 94+, Firefox 130+. 미지원 브라우저에는 안내 화면만 표시된다.
주 사용 환경은 iPad Safari — WebKit 특이사항에 대한 우회가 코드에 문서화되어 있다.
H.265(HEVC) 소스는 기기·브라우저의 디코더 지원에 따라 열리지 않을 수 있다.
4096px(4K) 초과 소스는 제한되며, 내보내기 해상도(원본/1440p/1080p/720p)를 선택할 수 있다.
