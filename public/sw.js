/* 現場拍照上傳系統 — Service Worker
 * 沿用 sample CAP/sw.js 的 stale-while-revalidate 策略，快取清單改為拆檔後的資源。
 *
 * 重點：只處理同源 GET。對 Apps Script 的跨域請求（登入／目錄／上傳）
 * 一律不介入，直接走網路——照片上傳絕不可被快取攔截。
 *
 * 改版時務必更新 CACHE 版本號，否則使用者會卡在舊版前端。
 */

// ⚠️ 這個版本號同時是畫面右上角顯示的版本（app.js 從 SW 取得後寫進標題）。
// 改版時務必遞增，否則使用者會卡在舊版前端，而且看不出手機上跑的是哪一版。
const CACHE = 'snapsync-shell-v8';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/config.js',
  './js/util.js',
  './js/api.js',
  './js/db.js',
  './js/auth.js',
  './js/tree.js',
  './js/camera.js',
  './js/queue.js',
  './js/app.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // 個別加入：任一資源失敗不會讓整個 SW 安裝失敗
      .then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // 上傳等非 GET 直接走網路

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // 跨域（Apps Script）不介入

  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
