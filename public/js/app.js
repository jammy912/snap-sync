/* app.js — 啟動流程、分頁切換、設定、Service Worker */
'use strict';

var App = window.App || {};
window.App = App;

App.app = (function () {
  var $ = App.util.$;
  var toast = App.util.toast;

  var SETTINGS_KEY = 'ss_settings';
  var settings = { maxEdge: 1600, quality: 0.7 };   // 規劃書建議值

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (s) settings = Object.assign(settings, s);
    } catch (e) {}
    $('maxEdge').value = settings.maxEdge;
    $('quality').value = settings.quality;
    $('endpointOverride').value = App.api.getOverride();
  }

  function saveSettings() {
    settings.maxEdge = Math.min(4000, Math.max(400, parseInt($('maxEdge').value, 10) || 1600));
    settings.quality = Math.min(1, Math.max(0.1, parseFloat($('quality').value) || 0.7));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    $('maxEdge').value = settings.maxEdge;
    $('quality').value = settings.quality;

    App.api.setOverride($('endpointOverride').value);
    toast('設定已儲存');
  }

  function switchTab(tab) {
    var buttons = document.querySelectorAll('nav.tabs button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].dataset.tab === tab);
    }
    $('cameraView').classList.toggle('active', tab === 'camera');
    $('treeView').classList.toggle('active', tab === 'tree');
    $('queueView').classList.toggle('active', tab === 'queue');
    $('settingsView').classList.toggle('active', tab === 'settings');

    if (tab === 'queue') App.queue.render();
    if (tab === 'tree') App.tree.render();
  }

  function updateNet() {
    var on = navigator.onLine;
    $('netDot').className = 'dot ' + (on ? 'online' : 'offline');
    $('netText').textContent = on ? '線上' : '離線';
  }

  function renderUserCard() {
    var s = App.auth.current();
    $('whoName').textContent = s ? (s.displayName || s.username) : '—';
    $('whoRoot').textContent = s ? (s.rootPath || '（全部目錄）') : '—';
  }

  /** 登入成功後（或啟動時已有有效 session）進入主流程 */
  function onLoggedIn() {
    renderUserCard();
    App.tree.loadCache().then(function () {
      return App.tree.refresh(true);      // 靜默更新目錄樹
    }).then(function () {
      return App.queue.refreshBadge();
    }).then(function () {
      return App.queue.flush(true);       // 補送上次未送出的照片
    });
  }

  function logout() {
    App.db.all().then(function (recs) {
      if (recs.length) {
        if (!confirm('尚有 ' + recs.length + ' 張照片未上傳，登出後仍會保留在本機。確定登出？')) return;
      }
      App.camera.stop();
      App.auth.clear();
      App.auth.showLogin('已登出');
    });
  }

  /* ---------- PWA 安裝 ---------- */
  var deferredPrompt = null;
  function initInstall() {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      $('installBtn').style.display = 'flex';
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      $('installBtn').style.display = 'none';
      toast('已加入主畫面');
    });
    $('installBtn').onclick = function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        $('installBtn').style.display = 'none';
      });
    };
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('SW 註冊失敗', e);
    });
  }

  function init() {
    loadSettings();
    updateNet();
    registerSW();
    initInstall();

    App.auth.init();
    App.tree.init();
    App.camera.init();
    App.queue.init();

    $('saveSettingsBtn').onclick = saveSettings;
    $('logoutBtn').onclick = logout;

    var buttons = document.querySelectorAll('nav.tabs button');
    for (var i = 0; i < buttons.length; i++) {
      (function (b) { b.onclick = function () { switchTab(b.dataset.tab); }; })(buttons[i]);
    }

    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);

    App.db.open().then(function () {
      App.auth.load();
      if (App.auth.isLoggedIn()) {
        App.auth.hideLogin();
        onLoggedIn();
      } else {
        App.auth.showLogin();
      }
    }).catch(function (e) {
      toast('資料庫開啟失敗：' + e.message);
    });
  }

  return {
    init: init, switchTab: switchTab, settings: function () { return settings; },
    onLoggedIn: onLoggedIn
  };
})();

document.addEventListener('DOMContentLoaded', App.app.init);
