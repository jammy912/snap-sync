/* build-config.js — 由 Vercel 環境變數產生 public/js/config.js
 *
 * 純靜態網站無法在 runtime 讀取 Vercel 環境變數（環境變數只存在於 build 期間
 * 或 Serverless Function 內），因此在 build 階段把 APPS_SCRIPT_URL 寫成一支
 * 前端可載入的 config.js。
 *
 * Vercel 設定：
 *   Build Command    : node scripts/build-config.js
 *   Output Directory : public
 *   環境變數          : APPS_SCRIPT_URL = https://script.google.com/macros/s/.../exec
 */
'use strict';

const fs = require('fs');
const path = require('path');

const url = (process.env.APPS_SCRIPT_URL || '').trim();

// 缺漏就直接中止 build，避免產生 endpoint 為 undefined 的檔案，
// 那會變成上線後才在手機上發現的謎樣錯誤。
if (!url) {
  console.error('[build-config] 錯誤：環境變數 APPS_SCRIPT_URL 未設定。');
  console.error('[build-config] 請在 Vercel 專案的 Settings → Environment Variables 加入該變數後重新部署。');
  process.exit(1);
}

// 允許在 /exec 後附加固定的存取參數（例如 ?k=亂數），用來擋掉路人層級的雜訊請求。
// 參數名不可用 token——那是 session token 的保留名稱，撞名會讓使用者全部登不進去。
if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?]+\/exec(\?[^#]*)?$/.test(url)) {
  console.error(`[build-config] 錯誤：APPS_SCRIPT_URL 格式不正確：${url}`);
  console.error('[build-config] 應為 https://script.google.com/macros/s/<部署ID>/exec');
  console.error('[build-config] 或附加固定存取參數：.../exec?k=<亂數>');
  process.exit(1);
}

// 撞名檢查：URL 上若帶 token= 會蓋掉使用者的 session token（同名取第一個值），
// 症狀是所有人都登不進去且錯誤訊息指向「請重新登入」，極難追查。
var qsIndex = url.indexOf('?');
if (qsIndex >= 0) {
  var usedNames = url.slice(qsIndex + 1).split('&')
    .map(function (pair) { return pair.split('=')[0].toLowerCase(); });
  var reserved = ['token', 'action', 'id'];
  var clash = usedNames.filter(function (n) { return reserved.indexOf(n) >= 0; });
  if (clash.length) {
    console.error(`[build-config] 錯誤：APPS_SCRIPT_URL 使用了保留參數名：${clash.join(', ')}`);
    console.error('[build-config] 這會覆蓋前端送出的同名參數，導致登入或上傳失效。');
    console.error('[build-config] 請改用其他名稱，例如 ?k=<亂數>');
    process.exit(1);
  }
}

const outPath = path.join(__dirname, '..', 'public', 'js', 'config.js');
const content = `/* 此檔由 scripts/build-config.js 於 build 時產生，請勿手動編輯或提交。 */
window.APP_CONFIG = ${JSON.stringify({ endpoint: url }, null, 2)};
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content, 'utf8');

// build log 可能被他人看到，故不印出完整端點；
// 尤其網址可能帶固定存取參數 k，印尾碼會直接把它洩漏出去。
const shown = url.slice(0, qsIndex >= 0 ? qsIndex : url.length);
const deployId = (shown.match(/\/s\/([^/]+)\/exec$/) || [])[1] || '';
console.log('[build-config] 已產生 ' + outPath);
console.log(`[build-config] 部署 ID 尾碼 …${deployId.slice(-6)}${qsIndex >= 0 ? '，並帶有固定存取參數' : ''}`);
