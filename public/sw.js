/**
 * scrim 서비스 워커 — 오프라인 지원(PWA).
 *
 * 개인정보 규칙: 여기의 fetch는 전부 "같은 오리진" 자산(HTML/JS/CSS/모델 wasm)의
 * 캐시·재검증이다. 외부 오리진 요청은 건드리지 않으며(어차피 페이지 CSP가 차단),
 * 사용자 미디어는 파일 객체로만 다뤄져 네트워크를 타지 않는다.
 *
 * 전략:
 *  - /assets/(해시 파일명), ?v= 버전 쿼리가 붙은 자산(models·파비콘) → cache-first
 *  - 그 외(index.html, manifest 등) → network-first, 오프라인이면 캐시 폴백
 *
 * network-first는 반드시 HTTP 캐시를 우회해야 한다. GitHub Pages가 HTML에
 * max-age를 붙이기 때문에 그냥 fetch하면 배포 후에도 브라우저가 옛 index.html을
 * 돌려주고, 그러면 새 해시 자산(JS/CSS)을 아예 참조하지 못해 앱이 갱신되지 않는다.
 *
 * CACHE 이름을 올리면 activate에서 옛 캐시를 전부 지운다 — 캐시 전략을 바꿀 때
 * 반드시 함께 올릴 것.
 */
const CACHE = 'scrim-runtime-v2';

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

  // ?v=<빌드 ID>가 붙은 고정 경로 자산(파비콘·매니페스트·모델)은 불변으로 다룬다
  const immutable =
    url.pathname.includes('/assets/') ||
    url.pathname.includes('/models/') ||
    url.searchParams.has('v');
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
    // cache: 'no-store'로 HTTP 캐시를 건너뛴다. 같은 오리진 GET만 오므로
    // URL로 다시 요청해도 안전하다 (navigate 요청은 Request 복제가 까다롭다).
    const res = await fetch(req.url, { cache: 'no-store', credentials: 'same-origin' });
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
