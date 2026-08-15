/* util.js — 共用小工具（沿用 sample 的 $ / toast / fmtTime / fmtSize） */
'use strict';

var App = window.App || {};
window.App = App;

App.util = (function () {
  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tmr);
    t._tmr = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  /** 顯示用：把 UTC ISO 字串轉當地時間 */
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 檔名用時間戳（當地時間，緊湊格式） */
  function stampForName(iso) {
    var d = new Date(iso);
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
           pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // 舊瀏覽器退路
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  return {
    $: $, toast: toast, fmtTime: fmtTime, stampForName: stampForName,
    fmtSize: fmtSize, uuid: uuid
  };
})();
