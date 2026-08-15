/* auth.js — 登入與 session 管理
 *
 * 密碼「用完即丟」：只在送出 login 請求時存在於記憶體，絕不寫入任何儲存。
 * 只保留伺服器簽發的 session token。
 *
 * 收到 401 類錯誤（token 失效／帳號停用）時清除憑證退回登入畫面，
 * 但【保留未上傳的照片佇列】—— 現場照片不能因為帳號被停用就消失。
 */
'use strict';

var App = window.App || {};
window.App = App;

App.auth = (function () {
  var $ = App.util.$;
  var KEY = 'ss_session';

  var session = null;   // { token, username, displayName, rootPath, expiresAt }

  function load() {
    try {
      session = JSON.parse(localStorage.getItem(KEY));
    } catch (err) {
      session = null;
    }
    return session;
  }

  function save(s) {
    session = s;
    localStorage.setItem(KEY, JSON.stringify(s));
  }

  function clear() {
    session = null;
    localStorage.removeItem(KEY);
  }

  function current() { return session; }
  function token() { return session ? session.token : null; }
  function isLoggedIn() { return !!(session && session.token); }

  /** 判斷錯誤是否為憑證失效（需要重新登入） */
  function isAuthError(err) {
    var code = err && err.code ? String(err.code) : '';
    return code === 'UNAUTHORIZED_SESSION' ||
           code === 'SESSION_EXPIRED' ||
           code === 'ACCOUNT_DISABLED';
  }

  function showLogin(msg) {
    var box = $('loginErr');
    if (msg) { box.textContent = msg; box.classList.add('show'); }
    else { box.classList.remove('show'); }
    $('loginPass').value = '';
    $('loginView').classList.add('active');
  }

  function hideLogin() {
    $('loginView').classList.remove('active');
    $('loginErr').classList.remove('show');
  }

  /** 憑證失效：清 session、退回登入畫面，但不動照片佇列 */
  function forceLogout(msg) {
    clear();
    showLogin(msg || '登入已失效，請重新登入');
  }

  function doLogin() {
    var u = $('loginUser').value.trim();
    var p = $('loginPass').value;
    if (!u || !p) { showLogin('請輸入帳號與密碼'); return; }

    $('loginBtn').disabled = true;
    $('loginBtn').textContent = '登入中…';

    App.api.login(u, p).then(function (data) {
      save({
        token: data.token,
        username: data.username,
        displayName: data.displayName,
        rootPath: data.rootPath,
        expiresAt: data.expiresAt
      });
      // 密碼欄位立即清空，不留在 DOM 中
      $('loginPass').value = '';
      hideLogin();
      App.app.onLoggedIn();
    }).catch(function (err) {
      showLogin(err.message || '登入失敗');
    }).finally(function () {
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = '登入';
    });
  }

  function init() {
    $('loginBtn').onclick = doLogin;
    // 密碼欄按 Enter 直接登入（現場戴手套操作，少按一次是一次）
    $('loginPass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
    $('loginUser').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('loginPass').focus();
    });
  }

  return {
    init: init, load: load, clear: clear, current: current, token: token,
    isLoggedIn: isLoggedIn, isAuthError: isAuthError,
    showLogin: showLogin, hideLogin: hideLogin, forceLogout: forceLogout
  };
})();
