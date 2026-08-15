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

if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
  console.error(`[build-config] 錯誤：APPS_SCRIPT_URL 格式不正確：${url}`);
  console.error('[build-config] 應為 https://script.google.com/macros/s/<部署ID>/exec');
  process.exit(1);
}

const outPath = path.join(__dirname, '..', 'public', 'js', 'config.js');
const content = `/* 此檔由 scripts/build-config.js 於 build 時產生，請勿手動編輯或提交。 */
window.APP_CONFIG = ${JSON.stringify({ endpoint: url }, null, 2)};
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content, 'utf8');

// 只印部署 ID 尾碼，避免完整端點寫進 build log
console.log(`[build-config] 已產生 ${outPath}（endpoint 尾碼 …${url.slice(-12)}）`);
