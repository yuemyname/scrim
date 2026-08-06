# DESIGN.md — null8 디자인 시스템 (이식 가능)

> 이 문서는 프로젝트에 독립적인 디자인 명세다. 새 프로젝트에서 이
> 파일 하나로 같은 룩앤필을 재현할 수 있도록 작성했다.
> 원본 구현: null8 (`src/style.css`, `src/ui.ts`)

---

## 1. 컨셉 한 줄

**흰 종이 위에 떠 있는 모노크롬 계측 장비.**
컬러는 장식이 아니라 신호(액센트 파랑, 상태 초록)로만 쓴다.

---

## 2. 컬러 토큰

```css
:root {
  --bg: #f4f4f2;      /* 페이지 배경 — 순백이 아닌 웜 오프화이트 */
  --panel: #ffffff;   /* 패널/유닛 내부 */
  --panel2: #ececec;  /* 보조 패널, 트랙 */
  --line: #dcdcdc;    /* 구분선, 버튼 테두리 */
  --accent: #141414;  /* 베젤, 액센트, 활성 상태 — "검정이 곧 액센트" */
  --ink: #222222;     /* 본문 텍스트 */
  --dim: #9a9a9a;     /* 보조 라벨 (소문자 UPPERCASE 라벨) */
  --lcd-bg: #141414;  /* LCD 칩 배경 */
  --lcd-fg: #f5f5f5;  /* LCD 칩 글자 */
}
```

**기능색 (신호로만 사용):**
- 파랑 `#1f6bff` — 브랜드/인터랙션 확정 신호 (앱 아이콘, 핀치 확정)
- 초록 `#28c840` — 진행 중 신호 (그리기 중)
- 그 외 어떤 컬러도 UI 크롬에 쓰지 않는다

---

## 3. 타이포그래피

- 폰트: `'SF Mono', 'Menlo', 'Consolas', 'Roboto Mono', monospace` — 전부 모노스페이스
- 기본 12px. 보조 라벨 9-10px + `letter-spacing: 0.1em` + `text-transform: uppercase`
- 수치 표시는 `font-variant-numeric: tabular-nums`

---

## 4. TV 유닛 레이아웃

콘텐츠(스크린)를 장비처럼 감싸는 구조. 페이지에 컴포넌트를 흩뿌리지 않는다.

```
흰 배경 (--bg), 화면 정중앙
└─ .device  (border: 2px solid var(--accent);
             box-shadow: 0 16px 48px rgba(0,0,0,0.1))
   ├─ 타이틀바: 그레이 신호등 3점(#c9c9c9/#ababab/#8a8a8a) +
   │            중앙 모노스페이스 경로 텍스트 + 우측 소형 버튼
   ├─ 스크린: 콘텐츠 영역 (검정 배경)
   └─ 컨트롤 바: 스크린 바로 아래 부착, 유닛 폭 = 스크린 폭
```

- 유닛 폭은 콘텐츠 폭에 맞춰 동기화 (JS로 설정)
- 컨트롤 바가 넘치면 가로 스크롤 (스크롤바 숨김)

---

## 5. 컴포넌트 스타일

**버튼** — 텍스트 라벨 필수 (아이콘 단독 금지, 방향/전환 글리프 ⇄ 정도만 예외)
```css
button {
  border: 1px solid var(--line); border-radius: 3px;
  background: #f7f7f7; color: var(--ink);
  font: 12px var(--font-mono); padding: 6px 10px;
}
button:active { background: #e4e4e4; }
```

**LCD 칩** — 수치·상태 표시 (타임코드/FPS/카운터류)
```css
.lcd {
  background: var(--lcd-bg); color: var(--lcd-fg);
  border-radius: 3px; padding: 3px 8px;
  font-variant-numeric: tabular-nums;
}
```

**라벨 + LCD 쌍**: `RABEL 00.0` 형태로 항상 붙여 쓴다
(라벨은 dim/uppercase/9px, 값은 LCD 칩)

---

## 6. 상태 표현 규칙 (핵심)

컬러 대신 **반전과 점멸**로 상태를 말한다:

| 상태 | 표현 |
|---|---|
| 활성/켜짐 | 반전 — `background: var(--accent); color: #fff` |
| 진행 중 (녹화 등) | 반전 + 1s 스텝 점멸 (`opacity 0.35` 토글) |
| 로딩 | 0.8s 스텝 점멸 |
| 에러 | 빠른 점멸 (0.4s) — 빨간색 쓰지 않음 |
| 대기/비활성 | dim 컬러 |

```css
@keyframes recblink { 50% { opacity: 0.35; } }
```

## 7. 캔버스 위 오버레이 (해당 시)

- 선/테두리: 흰색. 조정 중 = 점선, 확정 = 실선
- 포인터: 투명 원 + 흰 보더. 상태 전환 시 보더만 기능색으로
  (진행 = 초록, 확정 = 파랑)
- 그려지는 콘텐츠에는 대비 헤일로(밝은 색 → 어두운 외곽, 어두운 색 → 흰 외곽)

## 8. 기타 규칙

- 라운드는 3px로 절제 (유닛 베젤은 각짐)
- 이모지 아이콘 금지 — 쓸 경우 텍스트 프레젠테이션 강제 (`︎`)
- 앱 아이콘: 흰 배경 + 검정 라운드 베젤 + 중앙 파랑 원
- 다크 모드 없음 — 이 시스템은 화이트 톤 단일

---

## 9. 새 프로젝트에서 쓰는 법

1. 이 파일을 새 레포에 복사
2. Claude(또는 개발자)에게: "DESIGN.md의 디자인 시스템을 따라서 만들어줘"
3. §2 토큰을 CSS `:root`에 그대로 옮기는 것부터 시작
