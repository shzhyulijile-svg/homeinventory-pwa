// sw.js v11 —— 修复 iPhone（Safari / 主屏幕 PWA）下登录失败：
// "FetchEvent.respondWith received an error: TypeError: Load failed"
//
// 改动要点（依据见 修复说明.md）：
// 1. 跨域请求（CloudBase API 等）一律不拦截、不调 respondWith，
//    让浏览器走默认网络链路。v10 在 SW 里代发跨域 GET（fetch(request)），
//    该请求带 credentials:include，iOS 上必现 Load failed，
//    并以 respondWith 拒绝的形式炸回页面。
// 2. 所有 Cache API / fetch 调用都有兜底，respondWith 永不收到被拒绝的 Promise
//    （iOS 16.4/17 的 Cache API 会随机抛 "Internal error"，见 WebKit bug 261767）。
// 3. 缓存读取一律用 caches.open().then(cache => cache.match())，
//    不用 caches.match()（WebKit 工程师给出的规避方式）。
const CACHE_NAME = 'homeinventory-pwa-v15-cloudsync';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './backup-format.js',
  './cloudbase-sdk.js',
  './cloudbase-config.js',
  './sync-core.js',
  './cloudbase-client.js',
  './cloud-sync-controller.js',
  './pwa-bridge.js',
  './mobile-bridge.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => null) // 安装期缓存失败不致命，网络可用时照常运行
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .catch(() => null)
  );
  self.clients.claim();
});

function matchCache(request) {
  // iOS 17 下 caches.match 可能抛 "TypeError: Internal error"，
  // 统一走 open()->match 并吞掉异常，返回 null 表示未命中。
  return caches.open(CACHE_NAME)
    .then((cache) => cache.match(request).catch(() => null))
    .catch(() => null);
}

function putCache(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE_NAME)
    .then((cache) => cache.put(request, copy))
    .catch(() => null);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch (_) {
    return;
  }

  // 关键修复：跨域请求完全不经过 ServiceWorker。
  // 不要 respondWith(fetch(request)) —— 在 iOS 上代发跨域（尤其带凭证）请求
  // 会失败并污染页面侧的错误表现。
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          putCache('./index.html', response);
          return response;
        })
        .catch(() =>
          matchCache('./index.html').then((cached) => cached || Response.error())
        )
    );
    return;
  }

  event.respondWith(
    matchCache(request)
      .then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          putCache(request, response);
          return response;
        });
      })
      // 网络失败时最后兜底再查一次缓存；仍没有就返回明确的网络错误响应，
      // 绝不让 respondWith 收到被拒绝的 Promise。
      .catch(() =>
        matchCache(request).then((cached) => cached || Response.error())
      )
  );
});
