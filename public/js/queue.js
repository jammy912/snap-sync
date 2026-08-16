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

  // 放大檢視用。刻意與 objectURLs 分開管理——render() 會 revoke 掉整批縮圖
  // 的 URL，共用的話上傳完成重繪時，正在看的那張會變成破圖。
  var viewList = [];      // 目前檢視序列（與畫面排序一致）
  var viewIdx = -1;
  var viewURL = null;

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
  function retryDelay(rec) {
    var n = Math.min(rec.retryCount || 0, 5);
    return Math.min(Math.pow(2, n) * 60000, 30 * 60000);
  }

  function shouldRetry(rec) {
    if (!rec.lastTryAt) return true;
    return (Date.now() - rec.lastTryAt) >= retryDelay(rec);
  }

  /* ---------- 自動重送 ---------- */
  //
  // 【送出的觸發是手動、重送是自動】
  // 使用者按過「傳送」＝已經確認過這批要送，之後就不該再要求他盯著畫面
  // 一直按重送——現場常常是網路時好時壞，收訊回來時人可能在別的樓層。
  // 但沒按過傳送前絕不自動送（拍到一半、還沒檢查的照片不該偷跑）。
  // 存 localStorage：關掉 App 再開仍要繼續送已確認過的那批，
  // 否則現場關了 App，照片就停在手機裡等人再按一次。
  var AUTO_KEY = 'ss_auto_retry';
  var autoRetry = (function () {
    try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { return false; }
  })();
  var retryTimer = null;

  function setAutoRetry(on) {
    autoRetry = on;
    try {
      if (on) localStorage.setItem(AUTO_KEY, '1');
      else localStorage.removeItem(AUTO_KEY);
    } catch (e) {}
  }

  /** 依最接近的退避到期時間排下一次重送 */
  function scheduleRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!autoRetry) return;

    App.db.all().then(function (recs) {
      var pending = recs.filter(function (r) { return r.status !== 'sent'; });
      if (!pending.length) { setAutoRetry(false); return; }  // 全送完就停，不留空轉的計時器

      // 取最早可以重試的那一筆，等到它到期就整批再跑一次
      var wait = Math.min.apply(null, pending.map(function (r) {
        if (!r.lastTryAt) return 0;
        return Math.max(0, retryDelay(r) - (Date.now() - r.lastTryAt));
      }));
      // 至少隔 5 秒，避免連續失敗時瞬間狂打端點
      wait = Math.max(wait, 5000);

      retryTimer = setTimeout(function () {
        retryTimer = null;
        flush(true);        // 靜默重送，不洗版
      }, wait);
    }).catch(function () { /* 排程失敗不影響手動傳送 */ });
  }

  function uploadOne(rec) {
    return blobToBase64(rec.blob).then(function (b64) {
      return App.api.upload(App.auth.token(), rec, b64);
    }).then(function (resp) {
      // 【上傳成功的唯一定義：校驗通過】
      //
      // 伺服器端會拿 Drive 回報的 md5Checksum 與收到的位元組比對，不一致
      // 或無法取得都會回 ok:false，由 api.js 的 parse() 轉成例外走 catch，
      // 照片因此留在佇列重送。
      //
      // 這裡再擋一次 verified：萬一日後伺服器改版回傳了未驗證的成功，
      // 也不會靜默把本機唯一一份刪掉。刪除是不可逆的，多一層防護值得。
      if (!resp || resp.verified !== true) {
        var e = new Error('伺服器未回報校驗結果，保留本機重送');
        e.code = 'NOT_VERIFIED';
        throw e;
      }
      // 校驗通過，雲端已有正確副本，才能從本機移除
      return App.db.remove(rec.id);
    });
  }

  /**
   * 每送完一張就更新畫面。
   *
   * 不能只在整批結束後更新——一次傳 9 張時，計數會整整卡住不動，
   * 使用者看不出到底有沒有在動（實際回報過的狀況）。
   * 佇列分頁沒開著時只更新數字徽章，省下重繪縮圖的成本。
   */
  function tick() {
    return refreshBadge().then(function () {
      // 目錄浮層開著時，讓各目錄的 (張數) 跟著往下掉
      if (App.tree.isSheetOpen()) {
        return App.tree.refreshCounts().then(App.tree.render);
      }
    }).then(function () {
      if ($('queueView').classList.contains('active')) return render();
    }).catch(function () { /* 畫面更新失敗不該中斷上傳 */ });
  }

  /**
   * 送出所有待上傳照片。
   * @param {boolean} silent 靜默模式（自動重送時不洗版）
   *
   * silent=false 代表使用者親自按了「傳送」：忽略退避立刻全部重試，
   * 並開啟自動重送。silent=true 是自動重送，尊重退避時間。
   */
  function flush(silent) {
    if (flushing) return Promise.resolve();
    if (!App.auth.isLoggedIn()) return Promise.resolve();

    var manual = !silent;
    if (manual) {
      setAutoRetry(true);               // 按過傳送＝之後失敗自動重送
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }

    if (!navigator.onLine) {
      if (manual) toast('目前離線，恢復連線後會自動送出');
      scheduleRetry();                  // 離線也要排，連線回來時才追得上
      return Promise.resolve();
    }

    flushing = true;
    var ok = 0, fail = 0, authFailed = false;

    return App.db.all().then(function (recs) {
      var pending = recs.filter(function (r) {
        // 手動按傳送時不理會退避——使用者要的就是「現在送」
        return r.status !== 'sent' && (manual || shouldRetry(r));
      });
      if (!pending.length) return;

      if (!silent && pending.length > 1) toast('開始上傳 ' + pending.length + ' 張…');

      // 逐筆序列送出，避免同時大量請求打爆 Apps Script 並發限制
      return pending.reduce(function (chain, rec) {
        return chain.then(function () {
          if (authFailed) return;
          return uploadOne(rec).then(function () {
            ok++;
            return tick();           // 這張已送出，立刻讓計數往下跳
          }).catch(function (err) {
            if (App.auth.isAuthError(err)) {
              // 憑證失效：停止本輪，保留所有照片。
              // 同時關掉自動重送——token 已死，再重試也只是白打端點，
              // 等使用者重新登入後再由「傳送」重新啟動。
              authFailed = true;
              setAutoRetry(false);
              App.auth.forceLogout(err.message);
              return;
            }
            fail++;
            // 只寫回重試欄位，絕不整筆 put——那會連 blob 一起寫回去，
            // 在 iOS 上會讓失敗的那張變破圖（見 db.patch 的說明）。
            rec.retryCount = (rec.retryCount || 0) + 1;
            rec.lastError = err.message || String(err);
            rec.lastTryAt = Date.now();
            return App.db.patch(rec.id, {
              retryCount: rec.retryCount,
              lastError: rec.lastError,
              lastTryAt: rec.lastTryAt
            }).then(tick);                       // 失敗徽章也要即時反映
          });
        });
      }, Promise.resolve());
    }).then(function () {
      if (ok || fail) {
        if (!silent || fail) {
          toast('上傳完成：成功 ' + ok + '、失敗 ' + fail
            + (fail ? '（失敗的會自動重送）' : ''));
        }
      }
      return tick();               // 收尾再更新一次（涵蓋整批都被退避跳過的情況）
    }).catch(function (err) {
      toast('上傳流程錯誤：' + err.message);
    }).finally(function () {
      // 先解鎖再更新畫面，否則「傳送」鍵會停在 disabled
      // （refreshBadge 是依 flushing 決定按鈕狀態的）
      flushing = false;
      // 還有沒送掉的就排下一輪；全部送完 scheduleRetry 會自行關掉旗標
      scheduleRetry();
      return tick();
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
        // r.blob 可能不是有效的 Blob（舊版寫壞的記錄）。
        // createObjectURL 會直接丟例外，不擋的話整個 forEach 中斷，
        // 後面所有照片都不會被畫出來——一張壞的害整頁空白。
        var url = null;
        try {
          if (r.blob instanceof Blob) {
            url = URL.createObjectURL(r.blob);
            objectURLs.push(url);
          }
        } catch (e) { url = null; }

        var div = document.createElement('div');
        div.className = 'thumb';

        var badgeCls = r.retryCount > 0 ? 'error' : 'pending';
        var badgeTxt = r.retryCount > 0 ? '!' + r.retryCount : '⤴';

        var img = document.createElement('img');
        img.alt = '';
        if (url) {
          img.src = url;
          // blob 讀不到時，顯示明確訊息而不是瀏覽器的破圖圖示——
          // 現場看到「?」方塊只會困惑，不知道照片還在不在。
          img.onerror = function () {
            div.classList.add('broken');
            img.remove();
            var w = document.createElement('div');
            w.className = 'thumb-broken';
            w.textContent = '預覽讀取失敗';
            div.insertBefore(w, div.firstChild);
          };
        } else {
          div.classList.add('broken');
          var w0 = document.createElement('div');
          w0.className = 'thumb-broken';
          w0.textContent = '照片資料遺失';
          div.appendChild(w0);
        }

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

        div.onclick = function () { openViewer(r.id); };
        grid.appendChild(div);
      });

      // 放大檢視的序列沿用畫面排序，左右切換才跟看到的順序一致
      viewList = recs.map(function (r) { return r.id; });

      $('queueInfo').textContent = recs.length
        ? (recs.length + ' 張待上傳 · ' + App.util.fmtSize(totalSize))
        : '佇列已清空';
    });
  }

  /* ---------- 放大檢視 ---------- */

  function releaseViewURL() {
    if (viewURL) { URL.revokeObjectURL(viewURL); viewURL = null; }
  }

  /** 載入第 idx 張到檢視器；idx 超出範圍就關閉 */
  function showAt(idx) {
    if (idx < 0 || idx >= viewList.length) { closeViewer(); return Promise.resolve(); }
    viewIdx = idx;

    return App.db.get(viewList[idx]).then(function (r) {
      if (!r) {
        // 這張已被送出或刪除，把它從序列剔除後看下一張
        viewList.splice(idx, 1);
        return showAt(Math.min(idx, viewList.length - 1));
      }
      releaseViewURL();

      var img = $('viewerImg');
      img.classList.remove('zoomed');      // 換張時回到適應畫面
      if (r.blob instanceof Blob) {
        viewURL = URL.createObjectURL(r.blob);
        img.src = viewURL;
      } else {
        // 讀不到內容也要能開，使用者才看得到是哪一筆壞掉並刪除它
        img.removeAttribute('src');
        toast('這張照片的影像資料讀取不到');
      }

      $('viewerPath').textContent = r.targetPath || '—';
      $('viewerTime').textContent = App.util.fmtTime(r.capturedAt)
        + '　' + (idx + 1) + '/' + viewList.length;
      $('viewerInfo').textContent = (r.w && r.h ? r.w + '×' + r.h + ' · ' : '')
        + App.util.fmtSize(r.size)
        + (r.lastError ? ' · 上次失敗：' + r.lastError : '');

      $('viewerPrevBtn').disabled = (idx <= 0);
      $('viewerNextBtn').disabled = (idx >= viewList.length - 1);
    });
  }

  function openViewer(id) {
    var idx = viewList.indexOf(id);
    if (idx < 0) return;
    $('viewer').style.display = 'flex';
    showAt(idx);
  }

  function closeViewer() {
    $('viewer').style.display = 'none';
    releaseViewURL();
    $('viewerImg').removeAttribute('src');   // 讓瀏覽器儘早釋放解碼後的點陣圖
    viewIdx = -1;
  }

  function isViewerOpen() {
    return $('viewer').style.display !== 'none';
  }

  /** 刪除目前這張（拍糊了就地重拍，不必等傳上去才發現） */
  function deleteCurrent() {
    if (viewIdx < 0 || viewIdx >= viewList.length) return;
    var id = viewList[viewIdx];
    if (!confirm('刪除這張照片？照片只存在本機，刪除後無法復原。')) return;

    App.db.remove(id).then(function () {
      var at = viewList.indexOf(id);
      if (at >= 0) viewList.splice(at, 1);
      toast('已刪除');
      // 佇列與目錄張數都要跟著更新
      return tick().then(function () {
        // render() 會重建 viewList，這裡取剩下的同一位置繼續看
        if (!viewList.length) { closeViewer(); return; }
        return showAt(Math.min(at, viewList.length - 1));
      });
    }).catch(function (e) { toast('刪除失敗：' + e.message); });
  }

  function initViewer() {
    $('viewerCloseBtn').onclick = closeViewer;
    $('viewerPrevBtn').onclick = function () { showAt(viewIdx - 1); };
    $('viewerNextBtn').onclick = function () { showAt(viewIdx + 1); };
    $('viewerDelBtn').onclick = deleteCurrent;

    // 點圖片在「適應畫面」與「原尺寸」之間切換
    $('viewerImg').onclick = function () {
      this.classList.toggle('zoomed');
    };
    // 點圖片以外的黑色區域關閉
    $('viewerStage').onclick = function (e) {
      if (e.target === this) closeViewer();
    };

    window.addEventListener('keydown', function (e) {
      if (!isViewerOpen()) return;
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') showAt(viewIdx - 1);
      else if (e.key === 'ArrowRight') showAt(viewIdx + 1);
    });

    // 手機左右滑動換張
    var x0 = null;
    var stage = $('viewerStage');
    stage.addEventListener('touchstart', function (e) {
      x0 = e.touches.length === 1 ? e.touches[0].clientX : null;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      // 放大狀態下的滑動是在平移圖片，不該被當成換張
      if ($('viewerImg').classList.contains('zoomed')) return;
      if (Math.abs(dx) < 50) return;
      showAt(dx < 0 ? viewIdx + 1 : viewIdx - 1);
    }, { passive: true });
  }

  /**
   * 更新分頁徽章與拍照頁的「傳送」提示條。
   * 兩者資料來源相同，一起更新才不會出現「徽章有數字但傳送鍵不見了」。
   */
  function refreshBadge() {
    return App.db.all().then(function (recs) {
      $('countBadge').textContent = recs.length ? '(' + recs.length + ')' : '';

      var bar = $('sendBar');
      if (!recs.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';

      var total = 0, failed = 0;
      recs.forEach(function (r) {
        total += r.size || 0;
        if (r.retryCount > 0) failed++;
      });
      $('sendInfo').textContent = recs.length + ' 張待傳送 · ' + App.util.fmtSize(total)
        + (failed ? '（' + failed + ' 張曾失敗）' : '');
      $('sendNowBtn').disabled = flushing;
    });
  }

  function init() {
    initViewer();
    $('retryAllBtn').onclick = function () { flush(false); };
    $('sendNowBtn').onclick = function () { flush(false); };

    // 恢復連線：已經按過傳送的就立刻續送；沒按過的只提示，不偷跑
    //（使用者可能還在拍、或正要刪掉拍壞的那幾張）。
    window.addEventListener('online', function () {
      App.db.all().then(function (recs) {
        if (!recs.length) return;
        if (autoRetry) {
          toast('已恢復連線，繼續送出 ' + recs.length + ' 張');
          flush(true);
        } else {
          toast('已恢復連線，' + recs.length + ' 張待傳送');
        }
      });
    });
  }

  /** 啟動時呼叫：上次按過傳送但沒送完的，繼續送 */
  function resumeAutoRetry() {
    if (!autoRetry) return Promise.resolve();
    return flush(true);
  }

  return {
    init: init, flush: flush, render: render, refreshBadge: refreshBadge,
    resumeAutoRetry: resumeAutoRetry
  };
})();
