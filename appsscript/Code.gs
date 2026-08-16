/**
 * 工地拍照上傳系統 — Apps Script Web App
 * =====================================================================
 * 單一端點對外，PWA 與內部 PowerShell 都呼叫這支 /exec。
 *
 * 【部署前必做】
 *   1. 編輯器左側「服務」→ 新增「Drive API」（進階服務，v3）。
 *      未啟用會導致 ack 的 Drive.Files.remove() 報 "Drive is not defined"。
 *   2. 專案設定 → 指令碼屬性，加入：
 *        SHEET_ID          試算表 ID
 *        DRIVE_FOLDER_ID   Drive 暫存資料夾 ID
 *        ADMIN_TOKEN       內部端點用的強 token（只給 PowerShell）
 *        ACCESS_KEY        選用，見下方「固定存取參數 k」
 *   3. 執行一次 setupSheets()，建立五個分頁並把密碼欄設為純文字格式。
 *      不做這步，純數字密碼會被 Sheet 轉成數字、開頭的 0 消失，
 *      症狀是「密碼明明對卻登不進去」。
 *   4. 部署 → 新增部署作業 → 網頁應用程式
 *        執行身分：我       存取權：任何人
 *   5. 每次改完程式碼都要「管理部署作業 → 編輯 → 版本：新版本」，
 *      否則 /exec 仍跑舊碼（Apps Script 最常見的除錯陷阱）。
 *
 * 【固定存取參數 k（選用）】
 *   設了指令碼屬性 ACCESS_KEY 後，PWA 端點就必須帶上相同的 k 才放行，
 *   可擋掉「拿到網址就亂打」的掃描器。要設就兩邊都設、值必須一致：
 *        Apps Script 指令碼屬性 ACCESS_KEY = 亂數（不含 ?k=）
 *        Vercel 環境變數 APPS_SCRIPT_URL   = .../exec?k=同一組亂數
 *   ⚠️ 只設這邊沒設 Vercel，會讓所有人登不進去；兩邊都不設則功能停用。
 *   內部端點（updateTree/queue/download/ack）不受影響，PowerShell 不必改。
 *
 * 【跨域說明】
 *   PWA 佈署在 Vercel，屬跨域呼叫。Apps Script 不支援 OPTIONS preflight，
 *   故 PWA 端一律以 Content-Type: text/plain 送出 JSON 字串（CORS simple
 *   request，不觸發 preflight），此處用 e.postData.contents 取回再 parse。
 */

'use strict';

// ---------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------
var SHEET_TREE     = 'TREE';
var SHEET_QUEUE    = 'QUEUE';
var SHEET_USERS    = 'USERS';
var SHEET_SESSIONS = 'SESSIONS';
var SHEET_LOG      = 'LOG';

var SESSION_TTL_DAYS = 3650;              // 依需求：約 10 年，等同永不過期
var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;  // 解碼後 10MB 上限
var LOCK_TIMEOUT_MS  = 30000;

var TREE_HEADERS     = ['path', 'parent', 'name', 'updatedAt'];
var QUEUE_HEADERS    = ['id', 'targetPath', 'fileName', 'driveFileId', 'capturedAt', 'status', 'note'];
var USERS_HEADERS    = ['username', 'password', 'rootPath', 'displayName', 'active'];
var SESSIONS_HEADERS = ['token', 'username', 'issuedAt', 'expiresAt'];
var LOG_HEADERS      = ['time', 'event', 'detail'];

// ---------------------------------------------------------------------
// 進入點
// ---------------------------------------------------------------------
function doGet(e) {
  return handle(e, 'GET');
}

function doPost(e) {
  return handle(e, 'POST');
}

function handle(e, method) {
  try {
    var params = e && e.parameter ? e.parameter : {};
    var body = {};

    if (method === 'POST' && e && e.postData && e.postData.contents) {
      // PWA 以 text/plain 送 JSON 字串；PowerShell 亦同，統一由此解析
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        return json({ ok: false, error: 'BAD_JSON', message: '請求內容不是合法 JSON' });
      }
    }

    // GET 用 query string、POST 用 body，兩者皆可帶 action / token
    var action = body.action || params.action || '';
    var token  = body.token  || params.token  || '';

    // 未帶 action 的請求＝掃描器或誤觸網址的路人，直接擋掉不進業務邏輯。
    // 回應刻意不透露這是什麼服務。
    if (!action) {
      throttleNoise('no_action');
      return json({ ok: false, error: 'BAD_REQUEST', message: 'Bad Request' });
    }

    // 固定存取參數 k（選用）：擋掉路人層級的雜訊請求。
    // 只在指令碼屬性有設 ACCESS_KEY 時才啟用，未設則跳過（向下相容）。
    // 這不是身分驗證——k 會被 build 進前端而人人可見，真正的驗證仍靠
    // session token 與 ADMIN_TOKEN。
    if (!checkAccessKey(body, params)) {
      throttleNoise('bad_access_key');
      return json({ ok: false, error: 'BAD_REQUEST', message: 'Bad Request' });
    }

    switch (action) {
      // --- PWA 端 ---
      case 'login':      return actionLogin(body);
      case 'tree':       return actionTree(token);
      case 'upload':     return actionUpload(body, token);
      // --- 內部端（PowerShell）---
      case 'updateTree': return actionUpdateTree(body, token);
      case 'queue':      return actionQueue(token);
      case 'download':   return actionDownload(body, params, token);
      case 'ack':        return actionAck(body, token);
      default:
        throttleNoise('unknown_action:' + String(action).slice(0, 40));
        return json({ ok: false, error: 'UNKNOWN_ACTION', message: 'Bad Request' });
    }
  } catch (err) {
    // 任何未預期例外都回 JSON，避免 Apps Script 吐 HTML 錯誤頁讓前端無法解析
    logEvent('ERROR', String(err && err.stack ? err.stack : err));
    return json({ ok: false, error: 'INTERNAL', message: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// 設定與試算表存取
// ---------------------------------------------------------------------
function prop(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('指令碼屬性未設定：' + key);
  return v;
}

function ss() {
  return SpreadsheetApp.openById(prop('SHEET_ID'));
}

/** 取得分頁；不存在則建立並寫入表頭 */
function sheet(name, headers) {
  var book = ss();
  var sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

/** 讀整個分頁為物件陣列（含 _row 實際列號，供以 id 定位刪除） */
function readAll(name, headers) {
  var sh = sheet(name, headers);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    // 整列皆空則跳過（使用者手動刪列可能留下空白列）
    var empty = true;
    for (var c = 0; c < row.length; c++) {
      if (String(row[c]).trim() !== '') { empty = false; break; }
    }
    if (empty) continue;

    var obj = { _row: i + 2 };
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = row[j];
    out.push(obj);
  }
  return out;
}

function logEvent(event, detail) {
  try {
    var sh = sheet(SHEET_LOG, LOG_HEADERS);
    sh.appendRow([new Date().toISOString(), event, String(detail).slice(0, 4000)]);
  } catch (err) {
    // 記錄失敗不可影響主流程
  }
}

// ---------------------------------------------------------------------
// 雜訊與暴力嘗試防護
//
// Apps Script 取不到來源 IP（請求經 Google 邊緣轉送），因此無法做 IP 級
// 封鎖。以下用兩種可行的手段：
//   1. 未帶 action／未知 action 的請求直接擋下，並「取樣」記錄避免灌爆 LOG。
//   2. login 以「帳號」為鍵做速率限制，擋住對單一帳號的密碼暴力嘗試。
// ---------------------------------------------------------------------

var NOISE_LOG_INTERVAL_SEC = 300;   // 同類雜訊每 5 分鐘只記一次
var LOGIN_MAX_ATTEMPTS = 10;        // 單一帳號每 LOGIN_WINDOW_SEC 內的失敗上限
var LOGIN_WINDOW_SEC = 600;

/**
 * 檢查固定存取參數 k。
 *
 * 指令碼屬性 ACCESS_KEY 有設時才啟用；未設一律放行（向下相容，
 * 也讓 PowerShell 端不必跟著改）。
 *
 * ⚠️ 這【不是】身分驗證：k 會被 build 進前端 config.js，任何人開
 * DevTools 都看得到。它的作用只是擋掉「拿到網址就亂打」的路人與掃描器。
 * 真正的存取控制仍是 session token（PWA）與 ADMIN_TOKEN（內部）。
 *
 * PowerShell 端不送 k，故內部端點在此一律放行——它們本來就用更強的
 * ADMIN_TOKEN 驗證。
 */
function checkAccessKey(body, params) {
  var expected;
  try {
    expected = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  } catch (err) {
    return true;    // 讀不到屬性時不擋，避免把自己鎖在門外
  }
  if (!expected) return true;      // 未啟用

  var action = s(body.action || params.action || '');

  // 內部端點（PowerShell）不需帶 k，改由 ADMIN_TOKEN 把關
  if (action === 'updateTree' || action === 'queue' ||
      action === 'download' || action === 'ack') {
    return true;
  }

  var got = s(body.k || params.k || '');
  return got === s(expected);
}

/**
 * 記錄雜訊請求，但同一類型在時間窗內只記一次，
 * 避免掃描器把 LOG 分頁灌爆（Sheet 有 1000 萬儲存格上限）。
 */
function throttleNoise(kind) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'noise_' + kind;
    if (cache.get(key)) return;                       // 時間窗內已記過
    cache.put(key, '1', NOISE_LOG_INTERVAL_SEC);
    logEvent('NOISE', kind);
  } catch (err) {
    // 防護失敗不可影響主流程
  }
}

/** 檢查該帳號是否已被暫時鎖定（失敗次數過多） */
function isLoginLocked(username) {
  try {
    var cache = CacheService.getScriptCache();
    var n = parseInt(cache.get('lf_' + username) || '0', 10);
    return n >= LOGIN_MAX_ATTEMPTS;
  } catch (err) {
    return false;
  }
}

/** 累計一次登入失敗 */
function bumpLoginFailure(username) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'lf_' + username;
    var n = parseInt(cache.get(key) || '0', 10) + 1;
    cache.put(key, String(n), LOGIN_WINDOW_SEC);
    if (n === LOGIN_MAX_ATTEMPTS) {
      logEvent('LOGIN_LOCKED', username + ' 連續失敗 ' + n + ' 次，暫時鎖定 ' + LOGIN_WINDOW_SEC + ' 秒');
    }
    return n;
  } catch (err) {
    return 0;
  }
}

/** 登入成功後清掉失敗計數 */
function clearLoginFailure(username) {
  try {
    CacheService.getScriptCache().remove('lf_' + username);
  } catch (err) { }
}

// ---------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------
/** Sheet 讀回的值可能被自動轉型（純數字密碼變 number、開頭 0 消失），一律正規化 */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Sheet 的布林可能是 boolean 或 "TRUE"/"true" 字串 */
function isTrue(v) {
  if (v === true) return true;
  return s(v).toUpperCase() === 'TRUE';
}

/** 路徑正規化：統一分隔符為 /、去頭尾斜線、擋掉 .. 穿越 */
function normPath(p) {
  var t = s(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (t === '') return '';
  var parts = t.split('/');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '..' || parts[i] === '.') {
      throw new Error('路徑不合法：' + p);
    }
  }
  return parts.join('/');
}

/** child 是否位於 root 子樹內（root 為空代表全樹） */
function inSubtree(child, root) {
  if (root === '') return true;
  return child === root || child.indexOf(root + '/') === 0;
}

/**
 * 把 tree 端點回傳的「相對路徑」組回完整路徑。
 *
 * tree 回傳的 path 是相對於使用者 rootPath 的（rootPath=專案A 時回「區域1」），
 * 但 TREE 分頁存的是完整路徑（「專案A/區域1」），故上傳時必須先還原。
 *
 * 若前端送來的已是完整路徑（已含 rootPath 前綴）則原樣採用——這不會形成越權
 * 破口，因為呼叫端隨後仍會用 inSubtree 檢查；跨工地的完整路徑會在那裡被擋下。
 */
function resolveUserPath(relPath, root) {
  if (root === '') return relPath;
  if (relPath === '') return root;
  if (inSubtree(relPath, root)) return relPath;   // 已是完整路徑
  return root + '/' + relPath;
}

// ---------------------------------------------------------------------
// 驗證
// ---------------------------------------------------------------------
function requireAdmin(token) {
  if (s(token) !== s(prop('ADMIN_TOKEN'))) {
    throw new Error('UNAUTHORIZED_ADMIN');
  }
}

/**
 * 驗 session token：查 SESSIONS → 確認未過期 → 回查 USERS 確認 active。
 * active 為 FALSE 時即時失效，這是手機遺失後唯一的止血手段。
 */
function requireUser(token) {
  var tk = s(token);
  if (!tk) throw new Error('UNAUTHORIZED_SESSION');

  var sessions = readAll(SHEET_SESSIONS, SESSIONS_HEADERS);
  var session = null;
  for (var i = 0; i < sessions.length; i++) {
    if (s(sessions[i].token) === tk) { session = sessions[i]; break; }
  }
  if (!session) throw new Error('UNAUTHORIZED_SESSION');

  var expires = new Date(session.expiresAt);
  if (!isNaN(expires.getTime()) && expires.getTime() < Date.now()) {
    throw new Error('SESSION_EXPIRED');
  }

  var users = readAll(SHEET_USERS, USERS_HEADERS);
  for (var j = 0; j < users.length; j++) {
    if (s(users[j].username) === s(session.username)) {
      if (!isTrue(users[j].active)) throw new Error('ACCOUNT_DISABLED');
      return {
        username:    s(users[j].username),
        rootPath:    normPath(users[j].rootPath),
        displayName: s(users[j].displayName) || s(users[j].username)
      };
    }
  }
  throw new Error('UNAUTHORIZED_SESSION');
}

// ---------------------------------------------------------------------
// action: login (POST, PWA)
// ---------------------------------------------------------------------
function actionLogin(body) {
  var username = s(body.username);
  var password = s(body.password);

  if (!username || !password) {
    return json({ ok: false, error: 'BAD_REQUEST', message: '請輸入帳號與密碼' });
  }

  // 速率限制：擋住對單一帳號的密碼暴力嘗試。
  // 訊息不透露「帳號被鎖」以外的資訊，避免用來探測帳號是否存在。
  if (isLoginLocked(username)) {
    return json({
      ok: false,
      error: 'TOO_MANY_ATTEMPTS',
      message: '嘗試次數過多，請稍後再試'
    });
  }

  var users = readAll(SHEET_USERS, USERS_HEADERS);
  var user = null;
  for (var i = 0; i < users.length; i++) {
    if (s(users[i].username) === username) { user = users[i]; break; }
  }

  // 帳號不存在、密碼錯誤、帳號停用一律回相同訊息，不洩漏帳號是否存在
  var FAIL = { ok: false, error: 'LOGIN_FAILED', message: '帳號或密碼錯誤' };

  if (!user) {
    bumpLoginFailure(username);
    logEvent('LOGIN_FAIL', 'no such user: ' + username);
    return json(FAIL);
  }
  if (!isTrue(user.active)) {
    bumpLoginFailure(username);
    logEvent('LOGIN_FAIL', 'inactive: ' + username);
    return json(FAIL);
  }
  if (s(user.password) !== password) {
    bumpLoginFailure(username);
    logEvent('LOGIN_FAIL', 'bad password: ' + username);
    return json(FAIL);
  }

  clearLoginFailure(username);

  var now = new Date();
  var expires = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  var token = Utilities.getUuid();

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    sheet(SHEET_SESSIONS, SESSIONS_HEADERS)
      .appendRow([token, username, now.toISOString(), expires.toISOString()]);
  } finally {
    lock.releaseLock();
  }

  logEvent('LOGIN_OK', username);

  return json({
    ok: true,
    token: token,
    username: username,
    displayName: s(user.displayName) || username,
    rootPath: normPath(user.rootPath),
    expiresAt: expires.toISOString()
  });
}

// ---------------------------------------------------------------------
// action: tree (GET, PWA)
// ---------------------------------------------------------------------
/**
 * 只回傳該使用者 rootPath 子樹，且 path 轉為「相對於 rootPath」，
 * 讓前端可直接以使用者起點為根渲染。
 */
function actionTree(token) {
  var user;
  try {
    user = requireUser(token);
  } catch (err) {
    return json({ ok: false, error: String(err.message), message: '請重新登入' });
  }

  var rows = readAll(SHEET_TREE, TREE_HEADERS);
  var root = user.rootPath;
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var full = normPath(rows[i].path);
    if (full === '') continue;
    if (!inSubtree(full, root)) continue;

    // 轉為相對路徑：root 本身變成 ''（樹根），其餘去掉 "root/" 前綴
    var rel = root === '' ? full : (full === root ? '' : full.slice(root.length + 1));
    if (rel === '') continue;  // root 自身不列為節點，前端以「根目錄」呈現

    var parts = rel.split('/');
    out.push({
      path:   rel,
      parent: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
      name:   s(rows[i].name) || parts[parts.length - 1]
    });
  }

  return json({
    ok: true,
    rootPath: root,
    displayName: user.displayName,
    tree: out
  });
}

// ---------------------------------------------------------------------
// action: upload (POST, PWA)
// ---------------------------------------------------------------------
function actionUpload(body, token) {
  var user;
  try {
    user = requireUser(token);
  } catch (err) {
    return json({ ok: false, error: String(err.message), message: '請重新登入' });
  }

  var id = s(body.id);
  var fileName = s(body.fileName);
  var capturedAt = s(body.capturedAt);
  var dataB64 = s(body.data);

  if (!id || !fileName || !dataB64) {
    return json({ ok: false, error: 'BAD_REQUEST', message: '缺少必要欄位' });
  }

  // tree 端點回傳的是「相對於 rootPath」的路徑（例如 rootPath=專案A 時回 區域1），
  // 因此這裡必須先組回完整路徑（專案A/區域1）再做兩道比對，否則合法上傳會被誤判越權。
  var relPath, targetPath;
  try {
    relPath = normPath(body.targetPath);
  } catch (err) {
    return json({ ok: false, error: 'BAD_PATH', message: '目標路徑不合法' });
  }

  // 空路徑必須在 resolveUserPath 之前擋下：否則會被解析成使用者的 rootPath，
  // 變成「忘了選目錄卻靜默上傳到專案根目錄」，照片會落在錯誤位置。
  if (relPath === '') {
    return json({ ok: false, error: 'BAD_REQUEST', message: '請先選擇上傳目錄' });
  }

  targetPath = resolveUserPath(relPath, user.rootPath);

  // 防護一：必須落在該使用者子樹內（越權跨工地上傳的實際擋點）
  // 相對路徑經 resolveUserPath 後必然落在子樹內，但若前端誤送完整路徑，
  // 這道檢查仍會擋下跨工地的越權嘗試。
  if (!inSubtree(targetPath, user.rootPath)) {
    logEvent('UPLOAD_DENY', user.username + ' → ' + targetPath + '（越權）');
    return json({ ok: false, error: 'FORBIDDEN_PATH', message: '無權上傳到此目錄' });
  }

  // 防護二：必須命中 TREE 白名單（擋掉不存在的任意路徑）
  var treeRows = readAll(SHEET_TREE, TREE_HEADERS);
  var hit = false;
  for (var i = 0; i < treeRows.length; i++) {
    if (normPath(treeRows[i].path) === targetPath) { hit = true; break; }
  }
  if (!hit) {
    logEvent('UPLOAD_DENY', user.username + ' → ' + targetPath + '（不在 TREE 白名單）');
    return json({ ok: false, error: 'UNKNOWN_PATH', message: '目標目錄不存在，請重新整理目錄樹' });
  }

  // 防護三：檔名與型別
  if (!/\.jpe?g$/i.test(fileName)) {
    return json({ ok: false, error: 'BAD_FILETYPE', message: '只接受 JPEG 檔' });
  }
  var safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');

  // 解碼並檢查大小
  var bytes;
  try {
    bytes = Utilities.base64Decode(dataB64);
  } catch (err) {
    return json({ ok: false, error: 'BAD_DATA', message: '照片資料不是合法 base64' });
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: 'TOO_LARGE', message: '照片超過大小上限' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    // 冪等：同一 uuid 已存在就回傳既有結果，不重複寫入
    var queueRows = readAll(SHEET_QUEUE, QUEUE_HEADERS);
    for (var q = 0; q < queueRows.length; q++) {
      if (s(queueRows[q].id) === id) {
        return json({
          ok: true,
          duplicated: true,
          driveFileId: s(queueRows[q].driveFileId),
          message: '此照片已上傳過'
        });
      }
    }

    var folder = DriveApp.getFolderById(prop('DRIVE_FOLDER_ID'));
    var blob = Utilities.newBlob(bytes, 'image/jpeg', safeName);
    var file = folder.createFile(blob);

    sheet(SHEET_QUEUE, QUEUE_HEADERS).appendRow([
      id,
      targetPath,
      safeName,
      file.getId(),
      capturedAt || new Date().toISOString(),
      'pending',
      user.displayName
    ]);

    return json({ ok: true, driveFileId: file.getId() });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------
// action: updateTree (POST, PowerShell)
// ---------------------------------------------------------------------
function actionUpdateTree(body, token) {
  requireAdmin(token);

  var items = body.tree;
  if (!items || !items.length) {
    return json({ ok: false, error: 'BAD_REQUEST', message: 'tree 為空' });
  }

  var now = new Date().toISOString();
  var rows = [];
  for (var i = 0; i < items.length; i++) {
    var p = normPath(items[i].path);
    if (p === '') continue;
    var parts = p.split('/');
    rows.push([
      p,
      parts.length > 1 ? parts.slice(0, -1).join('/') : '',
      s(items[i].name) || parts[parts.length - 1],
      now
    ]);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sh = sheet(SHEET_TREE, TREE_HEADERS);
    // 覆寫：清掉舊資料列（保留表頭）再寫入
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, TREE_HEADERS.length).clearContent();
    }
    if (rows.length) {
      sh.getRange(2, 1, rows.length, TREE_HEADERS.length).setValues(rows);
    }
  } finally {
    lock.releaseLock();
  }

  return json({ ok: true, count: rows.length, updatedAt: now });
}

// ---------------------------------------------------------------------
// action: queue (GET, PowerShell)
// ---------------------------------------------------------------------
function actionQueue(token) {
  requireAdmin(token);

  var rows = readAll(SHEET_QUEUE, QUEUE_HEADERS);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (s(rows[i].status) !== 'pending') continue;
    out.push({
      id:          s(rows[i].id),
      targetPath:  s(rows[i].targetPath),
      fileName:    s(rows[i].fileName),
      driveFileId: s(rows[i].driveFileId),
      capturedAt:  s(rows[i].capturedAt),
      note:        s(rows[i].note)
    });
  }
  return json({ ok: true, count: out.length, items: out });
}

// ---------------------------------------------------------------------
// action: download (GET, PowerShell)
// ---------------------------------------------------------------------
function actionDownload(body, params, token) {
  requireAdmin(token);

  var id = s(body.id) || s(params.id);
  if (!id) return json({ ok: false, error: 'BAD_REQUEST', message: '缺少 id' });

  var rows = readAll(SHEET_QUEUE, QUEUE_HEADERS);
  for (var i = 0; i < rows.length; i++) {
    if (s(rows[i].id) !== id) continue;

    var fileId = s(rows[i].driveFileId);
    var blob = DriveApp.getFileById(fileId).getBlob();
    return json({
      ok: true,
      id: id,
      fileName: s(rows[i].fileName),
      targetPath: s(rows[i].targetPath),
      data: Utilities.base64Encode(blob.getBytes())
    });
  }
  return json({ ok: false, error: 'NOT_FOUND', message: '查無此 id：' + id });
}

// ---------------------------------------------------------------------
// action: ack (POST, PowerShell)
// ---------------------------------------------------------------------
/**
 * 永久刪除 Drive 檔並刪掉 QUEUE 該列。
 * 用 Drive.Files.remove()（進階服務 v3）而非 setTrashed，因為垃圾桶仍占
 * 15GB 配額、30 天後才自動清除，會讓「雲端只做中轉」的配額模型失效。
 * 刪列一律以 id 比對搜尋列號，不用快取列位置，避免列位移錯刪。
 */
function actionAck(body, token) {
  requireAdmin(token);

  var id = s(body.id);
  if (!id) return json({ ok: false, error: 'BAD_REQUEST', message: '缺少 id' });

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var rows = readAll(SHEET_QUEUE, QUEUE_HEADERS);
    for (var i = 0; i < rows.length; i++) {
      if (s(rows[i].id) !== id) continue;

      var fileId = s(rows[i].driveFileId);
      var driveDeleted = false;
      if (fileId) {
        try {
          Drive.Files.remove(fileId);   // 需啟用進階 Drive 服務
          driveDeleted = true;
        } catch (err) {
          // 檔案可能已被手動刪除；仍繼續刪 QUEUE 列，但記錄下來
          logEvent('ACK_DRIVE_FAIL', id + ' / ' + fileId + ' : ' + err);
        }
      }

      sheet(SHEET_QUEUE, QUEUE_HEADERS).deleteRow(rows[i]._row);
      return json({ ok: true, id: id, driveDeleted: driveDeleted });
    }
    // 已被前一輪處理掉：視為成功（冪等）
    return json({ ok: true, id: id, alreadyGone: true });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------
// 初始化工具（在編輯器手動執行一次，建立所有分頁與表頭）
// ---------------------------------------------------------------------
function setupSheets() {
  sheet(SHEET_TREE, TREE_HEADERS);
  sheet(SHEET_QUEUE, QUEUE_HEADERS);
  sheet(SHEET_USERS, USERS_HEADERS);
  sheet(SHEET_SESSIONS, SESSIONS_HEADERS);
  sheet(SHEET_LOG, LOG_HEADERS);

  // USERS 的 password 欄設為純文字，避免純數字密碼被轉成數字、開頭 0 消失
  var users = sheet(SHEET_USERS, USERS_HEADERS);
  users.getRange('B2:B').setNumberFormat('@');

  Logger.log('分頁建立完成：TREE / QUEUE / USERS / SESSIONS / LOG');
}

/**
 * 診斷進階 Drive 服務是否可用（在編輯器手動執行，看「執行記錄」）。
 *
 * ack 回傳 driveDeleted:false 時跑這支，它會直接指出是哪一種問題：
 * 服務沒啟用、識別碼取錯名字、還是版本不是 v3。
 */
function diagnoseDrive() {
  var out = [];

  if (typeof Drive === 'undefined') {
    out.push('✗ Drive 未定義 → 進階服務沒啟用，或識別碼不叫 Drive。');
    out.push('  修法：編輯器左側「服務」→ 新增 Drive API → 版本 v3 →');
    out.push('       識別碼必須保持預設的 Drive。');
    Logger.log(out.join('\n'));
    return;
  }
  out.push('✓ Drive 物件存在');

  if (!Drive.Files) {
    out.push('✗ Drive.Files 不存在 → 版本可能不對，請選 v3。');
    Logger.log(out.join('\n'));
    return;
  }
  out.push('✓ Drive.Files 存在');
  out.push(typeof Drive.Files.remove === 'function'
    ? '✓ Drive.Files.remove 可呼叫（v3 正確）'
    : '✗ Drive.Files.remove 不是函式 → 版本不是 v3，請改選 v3。');

  // 實際建一個暫存檔再刪，這才是真正證明「刪得掉」
  try {
    var folder = DriveApp.getFolderById(prop('DRIVE_FOLDER_ID'));
    var tmp = folder.createFile('__drive_selftest__.txt', 'selftest', MimeType.PLAIN_TEXT);
    var tmpId = tmp.getId();
    out.push('✓ 已在暫存夾建立測試檔 ' + tmpId);
    try {
      Drive.Files.remove(tmpId);
      out.push('✓✓ 永久刪除成功 —— ack 的 driveDeleted 應該會是 true');
    } catch (err) {
      out.push('✗ 刪除失敗：' + err);
      out.push('  測試檔 ' + tmpId + ' 仍在暫存夾，請手動刪除。');
    }
  } catch (err) {
    out.push('✗ 無法存取暫存夾：' + err);
    out.push('  請確認指令碼屬性 DRIVE_FOLDER_ID 正確。');
  }

  Logger.log(out.join('\n'));
}

/** 清理過期或已停用帳號的 session（可另設每日觸發器） */
function cleanupSessions() {
  var users = readAll(SHEET_USERS, USERS_HEADERS);
  var activeNames = {};
  for (var i = 0; i < users.length; i++) {
    if (isTrue(users[i].active)) activeNames[s(users[i].username)] = true;
  }

  var sessions = readAll(SHEET_SESSIONS, SESSIONS_HEADERS);
  var sh = sheet(SHEET_SESSIONS, SESSIONS_HEADERS);
  var removed = 0;

  // 由下往上刪，避免刪列造成後續列號位移
  for (var j = sessions.length - 1; j >= 0; j--) {
    var expires = new Date(sessions[j].expiresAt);
    var expired = !isNaN(expires.getTime()) && expires.getTime() < Date.now();
    var orphan = !activeNames[s(sessions[j].username)];
    if (expired || orphan) {
      sh.deleteRow(sessions[j]._row);
      removed++;
    }
  }
  Logger.log('已清除 ' + removed + ' 筆 session');
}
