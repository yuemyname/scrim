# scrim

브라우저 안에서만 동작하는 영상 얼굴 비식별화 도구.
업로드 없음. 서버 없음. 파일은 사용자 기기를 떠나지 않는다.

시위·집회·거리 촬영본처럼 동의 없이 찍힌 시민이 다수 등장하는 영상을 공개 전에 비식별화한다.
핵심 가치는 검출 성능이 아니라 **놓친 구간을 사용자에게 드러내고 손으로 덮게 하는 리뷰 루프**다.

## 시작하기

```sh
pnpm install
pnpm vendor:models   # MediaPipe wasm + 얼굴 검출 모델을 public/models/ 에 벤더링
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
    decode.ts         # WebCodecs 디코드 스트림 (백프레셔)
    detect.ts         # MediaPipe FaceDetector (다운스케일 검출, 정밀 모드)
    track.ts          # IoU 트래킹 + EMA 스무딩 + hold/보간 + 양끝 연장
    redact.ts         # 모자이크/솔리드/블러 합성 (blur 하한 강제)
    encode.ts         # VideoEncoder + mp4-muxer (오디오 패스스루)
    pipeline.ts       # 2-패스: analyze / render
  worker/             # 분석·렌더 전용 Worker
  ui/                 # 플레이어, 타임라인, 검증 스트립, 트랙/스타일 패널
```

## 개인정보 보장

- 모든 처리(디코딩·검출·합성·인코딩)는 브라우저 안에서 실행된다.
- MediaPipe wasm/모델은 CDN이 아니라 `public/models/` 에서 로드된다.
- `index.html` 의 CSP가 외부 연결을 차단한다 (`connect-src 'self'`).
- ESLint 커스텀 룰(`scrim/no-network`)이 `src/` 전역에서 `fetch`/`XMLHttpRequest`/`sendBeacon`/`WebSocket`/`EventSource` 사용을 금지한다. 예외는 `src/core/assets.ts` 하나뿐이며 `/models/` 경로만 허용된다.
- 개발자도구 네트워크 탭으로 직접 검증할 수 있다.

## 브라우저 요구사항

WebCodecs(`VideoDecoder`/`VideoEncoder`), `OffscreenCanvas`, 모듈 Worker.
Safari 16.4+, Chrome 94+, Firefox 130+. 미지원 브라우저에는 안내 화면만 표시된다.
