import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    // 모델/wasm은 해시 없는 고정 경로라 배포 후에도 브라우저 캐시가 남는다.
    // 빌드마다 바뀌는 버전 쿼리로 캐시를 무효화한다.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
