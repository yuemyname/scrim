/**
 * scrim 서비스 워커 — 오프라인 지원(PWA).
 *
 * 개인정보 규칙: 여기의 fetch는 전부 "같은 오리진" 자산(HTML/JS/CSS/모델 wasm)의
 * 캐시·재검증이다. 외부 오리진 요청은 건드리지 않으며(어차피 페이지 CSP가 차단),
 * 사용자 미디어는 파일 객체로만 다뤄져 네트워크를 타지 않는다.
 *
 * 전략:
 *  - /assets/(해시 파일명), /models/(?v= 버전 쿼리) → cache-first (불변 자산)
 *  - 그 외(index.html, manifest 등) → network-first, 오프라인이면 캐시 폴백
 */
const CACHE = 'scrim-runtime-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const immutable = url.pathname.includes('/assets/') || url.pathname.includes('/models/');
  e.respondWith(immutable ? cacheFirst(req, url) : networkFirst(req));
});

async function cacheFirst(req, url) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    // 같은 경로의 이전 버전(?v= 쿼리만 다른 항목)은 지워 캐시가 무한히 크지 않게
    const keys = await c.keys();
    await Promise.all(
      keys
        .filter((k) => {
          const ku = new URL(k.url);
          return ku.pathname === url.pathname && k.url !== req.url;
        })
        .map((k) => c.delete(k)),
    );
    await c.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await c.match(self.registration.scope);
      if (index) return index;
    }
    throw err;
  }
}
