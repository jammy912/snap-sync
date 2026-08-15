/* queue.js — 離線佇列與重送
 *
 * 設計要點：
 *  - 每筆帶前端產生的 uuid，伺服器以此冪等去重，重送不會重複入列。
 *  - 上傳成功才從本機移除；失敗則保留並記錄 lastError 供現場排查。
 *  - 重送觸發：拍照後、App 啟動、恢復連線（online 事件）、手動按鈕。
 *  - 連續失敗採指數退避，避免弱網時狂打端點。
 */
'use strict';

var App = window.App || {};
window.App = App;

App.queue = (function () {
  var $ = App.util.$;
  var toast = App.util.toast;

  var flushing = false;
  var objectURLs = [];

  /** blob → 純 base64（去掉 data:image/jpeg;base64, 前綴） */
  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        var comma = s.indexOf(',');
        res(comma >= 0 ? s.slice(comma + 1) : s);
      };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  /** 指數退避：第 n 次失敗後等 2^n 分鐘（上限 30 分鐘） */
  function shouldRetry(rec) {
    if (!rec.lastTryAt) return true;
    var n = Math.min(rec.retryCount || 0, 5);
    var waitMs = Math.min(Math.pow(2, n) * 60000, 30 * 60000);
    return (Date.now() - rec.lastTryAt) >= waitMs;
  }

  function uploadOne(rec) {
    return blobToBase64(rec.blob).then(function (b64) {
      return App.api.upload(App.auth.token(), rec, b64);
    }).then(function () {
      // 成功：從本機移除（照片已在雲端，接著由 PowerShell 拉回落地）
      return App.db.remove(rec.id);
    });
  }

  /**
   * 送出所有待上傳照片。
   * @param {boolean} silent 靜默模式（拍照後自動觸發時不洗版）
   */
  function flush(silent) {
    if (flushing) return Promise.resolve();
    if (!App.auth.isLoggedIn()) return Promise.resolve();
    if (!navigator.onLine) {
      if (!silent) toast('目前離線，照片已保留在佇列');
      return Promise.resolve();
    }

    flushing = true;
    var ok = 0, fail = 0, authFailed = false;

    return App.db.all().then(function (recs) {
      var pending = recs.filter(function (r) {
        return r.status !== 'sent' && shouldRetry(r);
      });
      if (!pending.length) return;

      if (!silent && pending.length > 1) toast('開始上傳 ' + pending.length + ' 張…');

      // 逐筆序列送出，避免同時大量請求打爆 Apps Script 並發限制
      return pending.reduce(function (chain, rec) {
        return chain.then(function () {
          if (authFailed) return;
          return uploadOne(rec).then(function () {
            ok++;
          }).catch(function (err) {
            if (App.auth.isAuthError(err)) {
              // 憑證失效：停止本輪，保留所有照片
              authFailed = true;
              App.auth.forceLogout(err.message);
              return;
            }
            fail++;
            rec.retryCount = (rec.retryCount || 0) + 1;
            rec.lastError = err.message || String(err);
            rec.lastTryAt = Date.now();
            return App.db.put(rec);
          });
        });
      }, Promise.resolve());
    }).then(function () {
      if (ok || fail) {
        if (!silent || fail) toast('上傳完成：成功 ' + ok + '、失敗 ' + fail);
      }
      return refreshBadge();
    }).then(function () {
      if ($('queueView').classList.contains('active')) return render();
    }).catch(function (err) {
      toast('上傳流程錯誤：' + err.message);
    }).finally(function () {
      flushing = false;
    });
  }

  function revokeURLs() {
    objectURLs.forEach(function (u) { URL.revokeObjectURL(u); });
    objectURLs = [];
  }

  function render() {
    return App.db.all().then(function (recs) {
      var grid = $('grid');
      revokeURLs();
      grid.innerHTML = '';

      recs.sort(function (a, b) {
        return new Date(b.capturedAt) - new Date(a.capturedAt);
      });

      $('queueEmpty').style.display = recs.length ? 'none' : 'block';

      var totalSize = 0;
      recs.forEach(function (r) {
        totalSize += r.size || 0;
        var url = URL.createObjectURL(r.blob);
        objectURLs.push(url);

        var div = document.createElement('div');
        div.className = 'thumb';

        var badgeCls = r.retryCount > 0 ? 'error' : 'pending';
        var badgeTxt = r.retryCount > 0 ? '!' + r.retryCount : '⤴';

        var img = document.createElement('img');
        img.src = url;
        img.alt = '';

        var badge = document.createElement('div');
        badge.className = 'up-badge ' + badgeCls;
        badge.textContent = badgeTxt;

        var meta = document.createElement('div');
        meta.className = 'meta';
        var t = document.createElement('div');
        t.textContent = App.util.fmtTime(r.capturedAt);
        var p = document.createElement('div');
        p.className = 'path';
        p.textContent = r.targetPath;
        meta.appendChild(t);
        meta.appendChild(p);

        div.appendChild(img);
        div.appendChild(badge);
        div.appendChild(meta);

        div.onclick = function () {
          if (r.lastError) toast('上次失敗：' + r.lastError);
          else toast(r.targetPath + ' · ' + App.util.fmtSize(r.size));
        };
        grid.appendChild(div);
      });

      $('queueInfo').textContent = recs.length
        ? (recs.length + ' 張待上傳 · ' + App.util.fmtSize(totalSize))
        : '佇列已清空';
    });
  }

  function refreshBadge() {
    return App.db.all().then(function (recs) {
      $('countBadge').textContent = recs.length ? '(' + recs.length + ')' : '';
    });
  }

  function init() {
    $('retryAllBtn').onclick = function () { flush(false); };
    window.addEventListener('online', function () { flush(true); });
  }

  return { init: init, flush: flush, render: render, refreshBadge: refreshBadge };
})();
