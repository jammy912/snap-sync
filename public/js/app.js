/* app.js — 啟動流程、分頁切換、設定、Service Worker */
'use strict';

var App = window.App || {};
window.App = App;

App.app = (function () {
  var $ = App.util.$;
  var toast = App.util.toast;

  // ⚠️ 改版時要跟 sw.js 的 CACHE 版本號一起遞增，兩者必須一致。
  // 顯示在標題右側，讓現場回報問題時能直接確認手機上跑的是哪一版——
  // PWA 會快取前端資源，「我已經部署了」不等於「使用者拿到了」。
  var VERSION = 'v17';

  var SETTINGS_KEY = 'ss_settings';
  var settings = { maxEdge: 1600, quality: 0.8 };

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
    settings.quality = Math.min(1, Math.max(0.1, parseFloat($('quality').value) || 0.8));
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
    $('queueView').classList.toggle('active', tab === 'queue');
    $('settingsView').classList.toggle('active', tab === 'settings');

    // 切分頁時關掉目錄浮層，避免它蓋在別的分頁上
    App.tree.closeSheet();

    // 離開佇列時退出選取模式，否則回來時還停在選取狀態、
    // 勾選的又是上次的那批，容易誤刪
    if (tab !== 'queue' && App.queue.isSelecting()) { App.queue.exitSelect(); }

    if (tab === 'queue') App.queue.render();
  }

  function updateNet() {
    var on = navigator.onLine;
    $('netDot').className = 'dot ' + (on ? 'online' : 'offline');
    $('netText').textContent = on ? '線上' : '離線';
    // 整組（含文字）跟著狀態變色，離線時一眼就看得到
    var wrap = $('netDot').parentNode;
    wrap.className = 'status-dot ' + (on ? 'is-online' : 'is-offline');
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
      // 沒按過「傳送」的照片不會自動送（拍到一半、還沒檢查的不該偷跑）；
      // 但上次已按過傳送、只是沒送完的，開 App 就接著送完。
      return App.queue.resumeAutoRetry();
    });
  }

  function logout() {
    App.db.all().then(function (recs) {
      if (recs.length) {
        if (!confirm('尚有 ' + recs.length + ' 張照片未上傳，登出後仍會保留在本機。確定登出？')) return;
      }
      App.camera.stop();
      App.auth.clear();
      // 清掉確認狀態：換人登入後，前一個人的照片不該被自動送出
      App.queue.unconfirmAll().then(function () {
        App.auth.showLogin('已登出');
      });
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

  /**
   * 擋掉 iOS Safari 的雙擊縮放與雙指縮放。
   *
   * iOS 10 起 Safari 刻意忽略 <meta viewport> 的 user-scalable=no（無障礙
   * 考量），雙擊仍會放大並把整個版面往上推——標題列、分頁列、「上傳至」列
   * 全部跑出畫面外，下方多出一塊空白（現場實際回報）。
   *
   * CSS 的 touch-action: manipulation 擋得掉大部分情況，但部分 iOS 版本
   * 仍會觸發，故這裡再補一道：偵測 300ms 內的第二次點擊就攔下來。
   * gesturestart 則是擋雙指縮放（Safari 專有事件）。
   */
  function preventZoom() {
    var lastTouch = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (now - lastTouch <= 300) {
        // ⚠️ 只擋非互動元素上的雙擊。
        //    無條件 preventDefault 會連快門、按鈕的第二次點擊一起吃掉，
        //    使用者快速連拍時第二張就按不出來。
        var t = e.target;
        var interactive = t && t.closest &&
          t.closest('button, a, input, select, textarea, .thumb, .tree-node');
        if (!interactive) { e.preventDefault(); }
      }
      lastTouch = now;
    }, { passive: false });

    // 雙指縮放（iOS Safari 專有事件，其他瀏覽器不會觸發）
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
      document.addEventListener(evt, function (e) { e.preventDefault(); });
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('SW 註冊失敗', e);
    });
  }

  function init() {
    // 登入畫面也要顯示：卡在登入時同樣需要知道版本
    $('appVer').textContent = VERSION;
    $('appVerLogin').textContent = VERSION;
    loadSettings();
    updateNet();
    registerSW();
    preventZoom();
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
