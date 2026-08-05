# scrim — Claude Code 작업 규칙

브라우저 전용 영상/사진 얼굴 비식별화 도구. 상세 스펙은 README.md 참고.

## 필수 규칙

### 다국어 (한국어/영어)
- **모든 사용자 노출 문자열은 `src/ui/i18n.ts`의 `t()` 함수를 거친다.**
  UI에 새 텍스트(버튼, 라벨, 토스트, 모달, 툴팁)를 추가할 때는 한국어 리터럴을
  직접 쓰지 말고 i18n 사전에 ko/en 두 언어를 등록한 뒤 `t('key')`로 사용할 것.
- 언어 전환은 상단바 토글로 이미 구현되어 있다. 새 화면을 만들면 전환 시
  다시 그려지는지(`rerenderCurrent`) 확인할 것.

### 개인정보 보장 (절대 위반 금지)
- `src/` 어디에서도 네트워크 API(fetch 등) 사용 금지 — ESLint `scrim/no-network`가 강제.
  유일한 예외는 `src/core/assets.ts`이며 자체 오리진 `/models/` 경로만 허용.
- 모델·wasm 런타임은 `public/models/`에 벤더링한다. CDN 금지.
- 가림이 "사라지는" 코드 경로를 만들지 말 것 — 알 수 없는 스타일 값은
  모자이크로 폴백한다 (redact.ts의 default 분기).

### 플랫폼
- 주 사용 환경은 **iPad Safari/WebKit**. WebKit 특이사항(모듈 워커 제약,
  ctx.filter 미지원, 하드웨어 코덱 런타임 실패 등)에 대한 우회가 코드 곳곳에
  주석으로 문서화되어 있다 — 제거하지 말 것.
- 터치 우선: 새 인터랙션은 키보드 없이도 가능해야 한다.

### 검증
- 변경 후 `pnpm exec tsc --noEmit && pnpm lint && pnpm build` 통과 필수.
- 푸시하면 GitHub Pages로 자동 배포된다 (`.github/workflows/pages.yml`).
- 모델/wasm 등 고정 경로 자산을 바꾸면 캐시 무효화(`?v=__BUILD_ID__`)를 확인할 것.
