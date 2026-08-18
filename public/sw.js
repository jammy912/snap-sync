/* 現場拍照上傳系統 — Service Worker
 * 靜態資源用 stale-while-revalidate；HTML 一律 network-first
 * （理由見下方 fetch 處理器，這是踩過的坑）。
 *
 * 重點：只處理同源 GET。對 Apps Script 的跨域請求（登入／目錄／上傳）
 * 一律不介入，直接走網路——照片上傳絕不可被快取攔截。
 *
 * 改版時務必更新 CACHE 版本號，否則使用者會卡在舊版前端。
 */

// ⚠️ 這個版本號同時是畫面右上角顯示的版本（app.js 從 SW 取得後寫進標題）。
// 改版時務必遞增，否則使用者會卡在舊版前端，而且看不出手機上跑的是哪一版。
const CACHE = 'snapsync-shell-v17';
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
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
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

  // ⚠️ HTML 一律 network-first。
  //
  // stale-while-revalidate 對 HTML 會出事：js 更新了、index.html 還是快取的
  // 舊版，新版 js 去取新版 HTML 才有的元素就拿到 null，整段初始化中斷。
  // （實測：v10 加了「選取」鈕，但拿到舊 HTML 的裝置整個佇列功能失效。）
  // HTML 很小，優先走網路的成本可以接受；離線時才退回快取。
  const isHTML = req.mode === 'navigate' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');

  if (isHTML) {
    event.respondWith(
      fetch(req).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match(req, { ignoreSearch: true })
                       .then(c => c || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    // ignoreSearch：圖示網址帶 ?v=15（強制 iOS 更新主畫面圖示用），
    // 但 ASSETS 裡存的是不帶查詢字串的路徑，不忽略就會整批 miss，
    // 離線時圖示全部載不出來。
    caches.match(req, { ignoreSearch: true }).then(cached => {
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
