import { defineConfig, type Plugin } from 'vite';

// 모델/wasm/파비콘은 해시 없는 고정 경로라 배포 후에도 브라우저 캐시가 남는다.
// 빌드마다 바뀌는 버전 쿼리로 캐시를 무효화한다. JS(define)와 HTML(플러그인)이
// 같은 값을 써야 하므로 한 곳에서 만든다.
const BUILD_ID = Date.now().toString(36);

/** index.html의 `__BUILD_ID__` 자리표시자를 치환한다 (define은 HTML에 적용되지 않는다). */
function htmlBuildId(): Plugin {
  return {
    name: 'scrim-html-build-id',
    transformIndexHtml: {
      order: 'post', // Vite가 base를 붙인 뒤에 치환한다
      handler: (html: string) => html.replaceAll('__BUILD_ID__', BUILD_ID),
    },
  };
}

export default defineConfig({
  plugins: [htmlBuildId()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
