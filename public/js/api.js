/* api.js — Apps Script 端點呼叫封裝
 *
 * 【跨域關鍵】
 * PWA 佈署在 Vercel，呼叫 Apps Script /exec 屬跨域。Apps Script 不支援
 * OPTIONS preflight，因此 POST 一律用 Content-Type: text/plain 送 JSON
 * 字串（CORS simple request，不觸發 preflight）。
 * 絕對不可改成 application/json，否則瀏覽器會先送 OPTIONS 而失敗。
 *
 * /exec 會 302 轉址到 script.googleusercontent.com，這是正常行為，
 * 保留 fetch 預設的 redirect: 'follow' 即可。
 */
'use strict';

var App = window.App || {};
window.App = App;

App.api = (function () {
  var ENDPOINT_OVERRIDE_KEY = 'ss_endpoint_override';

  function endpoint() {
    var override = (localStorage.getItem(ENDPOINT_OVERRIDE_KEY) || '').trim();
    if (override) return override;
    if (window.APP_CONFIG && window.APP_CONFIG.endpoint) return window.APP_CONFIG.endpoint;
    throw new Error('端點未設定：請確認 Vercel 環境變數 APPS_SCRIPT_URL 已設定並重新部署');
  }

  function setOverride(url) {
    var v = (url || '').trim();
    if (v) localStorage.setItem(ENDPOINT_OVERRIDE_KEY, v);
    else localStorage.removeItem(ENDPOINT_OVERRIDE_KEY);
  }

  function getOverride() {
    return localStorage.getItem(ENDPOINT_OVERRIDE_KEY) || '';
  }

  function post(payload) {
    return fetch(endpoint(), {
      method: 'POST',
      // 必須是 text/plain，見檔頭說明
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(parse);
  }

  function get(params) {
    var url = endpoint();
    var qs = Object.keys(params)
      .filter(function (n) { return params[n] !== undefined && params[n] !== null; })
      .map(function (n) { return encodeURIComponent(n) + '=' + encodeURIComponent(params[n]); })
      .join('&');

    // 端點網址本身可能已帶固定的存取參數（例如 ...?k=xxxx），
    // 此時必須用 & 續接而非 ?，否則第二個 ? 會讓後面的參數全部失效。
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return fetch(url + sep + qs, { method: 'GET' }).then(parse);
  }

  function parse(resp) {
    return resp.text().then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        // Apps Script 發生未攔截錯誤時會回 HTML 錯誤頁
        throw new Error('伺服器回應非 JSON（HTTP ' + resp.status + '），請確認端點網址與部署版本');
      }
      if (!data.ok) {
        var e = new Error(data.message || data.error || '請求失敗');
        e.code = data.error;
        throw e;
      }
      return data;
    });
  }

  return {
    endpoint: endpoint,
    setOverride: setOverride,
    getOverride: getOverride,

    login: function (username, password) {
      return post({ action: 'login', username: username, password: password });
    },
    tree: function (token) {
      return get({ action: 'tree', token: token });
    },
    upload: function (token, rec, base64) {
      return post({
        action: 'upload',
        token: token,
        id: rec.id,
        targetPath: rec.targetPath,
        fileName: rec.fileName,
        capturedAt: rec.capturedAt,
        data: base64
      });
    }
  };
})();
