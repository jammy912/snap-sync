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

  // 使用者按下「取消傳送」時設為 true，送完當前這張就停手。
  // 不中斷進行中的那一張——HTTP 請求已經送出，強行放棄只會讓伺服器
  // 收到照片但本機不知道，下次重送要靠冪等去重，多繞一圈。
  var cancelRequested = false;

  // 多選刪除用。只在選取模式有效，離開選取模式就清空。
  var selecting = false;
  var picked = {};        // { id: true }

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

  /* ---------- 確認與自動重送 ---------- */
  //
  // 【送出的觸發是手動、重送是自動】
  // 使用者按過「傳送」＝已經確認過這批要送，之後就不該再要求他盯著畫面
  // 一直按重送——現場常常是網路時好時壞，收訊回來時人可能在別的樓層。
  //
  // ★ 確認狀態記在【每一筆照片】上（rec.confirmed），不是一個全域旗標。
  //   全域旗標會讓「上一批還沒傳完時新拍的照片」被自動帶著送出去——
  //   那批根本沒被確認過，使用者可能正要檢查或刪掉重拍。
  //   改成逐筆標記後，未確認的照片無論如何都不會被送。

  /** 這筆是否已被使用者確認要送 */
  function isConfirmed(r) { return r.confirmed === true; }

  /** 清掉所有確認狀態（登出／憑證失效時用，避免換人登入後被自動送出） */
  function unconfirmAll() {
    return App.db.all().then(function (recs) {
      return recs.filter(isConfirmed).reduce(function (chain, r) {
        return chain.then(function () { return App.db.patch(r.id, { confirmed: false }); });
      }, Promise.resolve());
    }).catch(function () { /* 清不掉不影響主流程 */ });
  }

  /** 取出所有待送（未送出）的記錄 */
  function pendingOf(recs) {
    return recs.filter(function (r) { return r.status !== 'sent'; });
  }

  var retryTimer = null;

  /** 依最接近的退避到期時間排下一次重送 */
  function scheduleRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    App.db.all().then(function (recs) {
      // 只看已確認的：未確認的照片不該讓重試計時器空轉
      var pending = pendingOf(recs).filter(isConfirmed);
      if (!pending.length) return;   // 已確認的都送完了，不留空轉的計時器

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
    if (manual && retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    flushing = true;
    cancelRequested = false;      // 每次開始傳送都重置，否則上一輪的取消會殘留
    var ok = 0, fail = 0, authFailed = false, cancelled = false;

    // 手動按傳送：先把「目前佇列裡的照片」逐筆標記為已確認。
    // 標記完才開始送，因此標記之後才拍的照片不在這一批裡，
    // 必須等這批送完、使用者再按一次傳送才會送出。
    //
    // ★ batchIds 記下這一批到底是哪幾筆，送出時只認這份名單。
    //   不可以在標記完之後重新 App.db.all() 再篩 confirmed——
    //   逐筆 patch 是 N 個獨立 transaction，每筆之間都會交還事件迴圈，
    //   使用者此時按快門，新照片就可能擠進重讀的結果裡被一起送出。
    //   實測症狀：整批傳完後拍的第一張會自己送出，第二張之後才正常等確認。
    var batchIds = null;
    var prepare = manual
      ? App.db.all().then(function (recs) {
          var todo = pendingOf(recs).filter(function (r) { return !isConfirmed(r); });
          batchIds = {};
          pendingOf(recs).forEach(function (r) { batchIds[r.id] = true; });
          return todo.reduce(function (chain, r) {
            return chain.then(function () { return App.db.patch(r.id, { confirmed: true }); });
          }, Promise.resolve());
        })
      : Promise.resolve();

    return prepare.then(function () {
      if (!navigator.onLine) {
        if (manual) toast('目前離線，恢復連線後會自動送出');
        return null;                    // 交給 finally 的 scheduleRetry 接手
      }
      return App.db.all();
    }).then(function (recs) {
      if (!recs) return;

      var pending = pendingOf(recs).filter(function (r) {
        // 手動送出時只認 prepare 當下的那份名單，之後新拍的一律不送
        if (batchIds && !batchIds[r.id]) return false;
        // 【只送已確認的】未確認＝使用者還沒按傳送檢查過，一律不送
        if (!isConfirmed(r)) return false;
        // 手動按傳送時不理會退避——使用者要的就是「現在送」
        return manual || shouldRetry(r);
      });
      if (!pending.length) return;

      if (!silent && pending.length > 1) toast('開始上傳 ' + pending.length + ' 張…');

      // 逐筆序列送出，避免同時大量請求打爆 Apps Script 並發限制
      return pending.reduce(function (chain, rec) {
        return chain.then(function () {
          if (authFailed) return;
          // 使用者按了取消：停止送出後面的，已送出的不受影響
          if (cancelRequested) { cancelled = true; return; }
          return uploadOne(rec).then(function () {
            ok++;
            return tick();           // 這張已送出，立刻讓計數往下跳
          }).catch(function (err) {
            if (App.auth.isAuthError(err)) {
              // 憑證失效：停止本輪，保留所有照片。
              // token 已死，再重試也只是白打端點，等重新登入後由使用者
              // 再按一次傳送。unconfirmAll 會把確認狀態清掉，
              // 避免換人登入後前一個人的照片被自動送出。
              authFailed = true;
              App.auth.forceLogout(err.message);
              return unconfirmAll();
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
      if (cancelled) {
        // 取消後剩下的仍是「已確認」狀態，會由自動重送接手繼續送。
        // 這點必須講明白，否則使用者以為按了取消就不會再送了。
        return App.db.all().then(function (recs) {
          var left = pendingOf(recs).filter(isConfirmed).length;
          toast('已停止傳送：完成 ' + ok + ' 張'
            + (left ? '，剩 ' + left + ' 張仍會自動重送（要完全停止請直接刪除）' : ''));
          return tick();
        });
      }
      if (!(ok || fail)) return tick();
      if (silent && !fail) return tick();

      // 這批送出期間新拍的照片沒被送（未確認），要明講，
      // 否則使用者會以為「傳送完了」就收工走人。
      return App.db.all().then(function (recs) {
        var waiting = pendingOf(recs).filter(function (r) { return !isConfirmed(r); }).length;
        toast('上傳完成：成功 ' + ok + '、失敗 ' + fail
          + (fail ? '（失敗的會自動重送）' : '')
          + (waiting ? '；另有 ' + waiting + ' 張新照片待確認' : ''));
        return tick();
      });
    }).catch(function (err) {
      toast('上傳流程錯誤：' + err.message);
    }).finally(function () {
      // 先解鎖再更新畫面，否則「傳送」鍵會停在 disabled
      // （refreshBadge 是依 flushing 決定按鈕狀態的）
      flushing = false;
      cancelRequested = false;
      // 還有沒送掉的就排下一輪；全部送完 scheduleRetry 會自行關掉旗標。
      // 取消後仍要排——剩下的是已確認的照片，本來就該繼續送，
      // 只是不再佔用使用者當下的操作（退避間隔至少 5 秒）。
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
      grid.classList.toggle('selecting', selecting);

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

        if (selecting) {
          var isPicked = !!picked[r.id];
          if (isPicked) div.classList.add('picked');
          var pick = document.createElement('div');
          pick.className = 'pick';
          pick.textContent = isPicked ? '✓' : '';
          div.appendChild(pick);
          // 選取模式下點縮圖是勾選，不開放大檢視
          div.onclick = function () { togglePick(r.id); };
        } else {
          div.onclick = function () { openViewer(r.id); };
        }
        grid.appendChild(div);
      });

      // 放大檢視的序列沿用畫面排序，左右切換才跟看到的順序一致
      viewList = recs.map(function (r) { return r.id; });

      // 清掉已不存在的勾選（照片可能在別處被刪、或上傳成功而移除），
      // 否則刪除鍵的計數會比畫面上看到的多。
      if (selecting) {
        var alive = {};
        recs.forEach(function (r) { alive[r.id] = true; });
        var changed = false;
        Object.keys(picked).forEach(function (id) {
          if (!alive[id]) { delete picked[id]; changed = true; }
        });
        if (changed) updateSelectUI();
      }

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

      var pending = pendingOf(recs);
      var waiting = pending.filter(function (r) { return !isConfirmed(r); });
      var sending = pending.filter(isConfirmed);

      var wSize = 0;
      waiting.forEach(function (r) { wSize += r.size || 0; });
      var failed = pending.filter(function (r) { return r.retryCount > 0; }).length;

      var btn = $('sendNowBtn');

      if (flushing) {
        // 傳送中：按鈕變成「取消傳送」，讓使用者能中途停手
        //（例如選錯目錄、或臨時要先傳別批）。
        if (cancelRequested) {
          $('sendInfo').textContent = '停止中… 送完目前這張就停';
          btn.disabled = true;
          btn.textContent = '停止中…';
        } else {
          $('sendInfo').textContent = '傳送中… 剩 ' + sending.length + ' 張'
            + (waiting.length ? '，' + waiting.length + ' 張待這批完成後確認' : '');
          btn.disabled = false;
          btn.textContent = '取消傳送';
        }
        return;
      }

      btn.disabled = false;
      if (waiting.length) {
        // 有沒確認過的照片：按鈕就是要送這些
        $('sendInfo').textContent = waiting.length + ' 張待確認傳送 · ' + App.util.fmtSize(wSize)
          + (sending.length ? '（另有 ' + sending.length + ' 張排隊重送中）' : '');
        btn.textContent = '傳送';
      } else {
        // 全部確認過了，只剩失敗待自動重送
        $('sendInfo').textContent = sending.length + ' 張已確認，等待自動重送'
          + (failed ? '（' + failed + ' 張曾失敗）' : '');
        btn.textContent = '立即重試';
      }
    });
  }

  /* ---------- 取消傳送 ---------- */

  /**
   * 請求停止傳送。
   *
   * 不中斷進行中的那一張：HTTP 請求已經送出，強行放棄只會變成
   * 「伺服器收到了但本機不知道」，下次重送得靠冪等去重，白繞一圈。
   * 因此送完當前這張就停，剩下的交給自動重送。
   */
  function cancelFlush() {
    if (!flushing || cancelRequested) return;
    cancelRequested = true;
    toast('送完目前這張就停止');
    refreshBadge();
  }

  /* ---------- 多選刪除 ---------- */

  function pickedIds() { return Object.keys(picked); }

  function updateSelectUI() {
    var n = pickedIds().length;
    $('selectInfo').textContent = '已選 ' + n + ' 張';
    $('deleteSelBtn').disabled = (n === 0);
  }

  function enterSelect() {
    selecting = true;
    picked = {};
    $('selectBar').style.display = 'flex';
    $('selectModeBtn').style.display = 'none';
    updateSelectUI();
    return render();
  }

  function exitSelect() {
    selecting = false;
    picked = {};
    $('selectBar').style.display = 'none';
    $('selectModeBtn').style.display = '';
    return render();
  }

  function togglePick(id) {
    if (picked[id]) { delete picked[id]; } else { picked[id] = true; }
    updateSelectUI();
    return render();
  }

  /** 刪除所有勾選的照片。刪除不可逆，一律先確認。 */
  function deletePicked() {
    var ids = pickedIds();
    if (!ids.length) return Promise.resolve();

    // 傳送中不給刪：正在送的那張刪掉會讓 uploadOne 拿到已失效的記錄。
    if (flushing) {
      toast('傳送中無法刪除，請先按「取消傳送」');
      return Promise.resolve();
    }

    if (!confirm('確定刪除選取的 ' + ids.length + ' 張照片？\n照片只存在這支手機，刪除後無法復原。')) {
      return Promise.resolve();
    }

    return ids.reduce(function (chain, id) {
      return chain.then(function () { return App.db.remove(id); });
    }, Promise.resolve()).then(function () {
      toast('已刪除 ' + ids.length + ' 張');
      return exitSelect();
    }).then(function () {
      return App.tree.refreshCounts().then(App.tree.render);
    }).then(tick).catch(function (e) {
      toast('刪除失敗：' + e.message);
    });
  }

  function init() {
    initViewer();
    $('retryAllBtn').onclick = function () { flush(false); };

    // 同一顆按鈕兩種行為：閒置時送出、傳送中則取消
    $('sendNowBtn').onclick = function () {
      if (flushing) { cancelFlush(); } else { flush(false); }
    };

    $('selectModeBtn').onclick = function () { enterSelect(); };
    $('selectCancelBtn').onclick = function () { exitSelect(); };
    $('deleteSelBtn').onclick = function () { deletePicked(); };

    $('selectAllBtn').onclick = function () {
      App.db.all().then(function (recs) {
        // 全部已選就取消全選，否則全選——同一顆鍵兩用，省一個按鈕
        var all = recs.length > 0 && recs.every(function (r) { return picked[r.id]; });
        picked = {};
        if (!all) { recs.forEach(function (r) { picked[r.id] = true; }); }
        updateSelectUI();
        return render();
      });
    };

    // 恢復連線：只續送【已確認】的那些；未確認的只提示，不偷跑
    //（使用者可能還在拍、或正要刪掉拍壞的那幾張）。
    window.addEventListener('online', function () {
      App.db.all().then(function (recs) {
        var pending = pendingOf(recs);
        if (!pending.length) return;
        var confirmed = pending.filter(isConfirmed).length;
        if (confirmed) {
          toast('已恢復連線，繼續送出 ' + confirmed + ' 張');
          flush(true);
        } else {
          toast('已恢復連線，' + pending.length + ' 張待確認傳送');
        }
      });
    });
  }

  /** 啟動時呼叫：上次已確認但沒送完的，繼續送（未確認的不動） */
  function resumeAutoRetry() {
    return App.db.all().then(function (recs) {
      if (!pendingOf(recs).filter(isConfirmed).length) return;
      return flush(true);
    });
  }

  return {
    init: init, flush: flush, render: render, refreshBadge: refreshBadge,
    resumeAutoRetry: resumeAutoRetry, unconfirmAll: unconfirmAll,
    exitSelect: exitSelect, isSelecting: function () { return selecting; }
  };
})();
