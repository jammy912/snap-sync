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

  // 使用者主動取消過，且還沒再按「傳送」。
  //
  // ⚠️ 這個旗標存在的理由：取消【必須真的停下來】。
  //    原本 flush 的 finally 一律呼叫 scheduleRetry()，於是按下取消後
  //    約 5 秒又自動 flush(true) 重新開始，flushing 再度變 true——
  //    畫面上傳送鍵已回到「傳送」，但按「選取」卻被擋下說「傳送中無法
  //    選取」，兩邊互相矛盾（使用者實際回報）。
  //    取消的語意是「停」，不是「等五秒再繼續」。
  var autoRetryPaused = false;

  // 多選刪除用。只在選取模式有效，離開選取模式就清空。
  var selecting = false;
  var picked = {};        // { id: true }

  // 拖曳框選：dragTouched 記錄本次拖曳已處理過的張數，
  // 避免手指在同一張上來回抖動時重複觸發。
  var dragging = false;
  var dragTouched = {};

  // 放大檢視用。刻意與 objectURLs 分開管理——render() 會 revoke 掉整批縮圖
  // 的 URL，共用的話上傳完成重繪時，正在看的那張會變成破圖。
  var viewList = [];      // 目前檢視序列（與畫面排序一致）
  var viewIdx = -1;
  var viewURL = null;

  /**
   * 從本機移除一張照片。
   *
   * ⚠️ 一律走這裡，不要直接呼叫 App.db.remove()。
   * 拍照頁的相簿要跟著重畫，否則留著一張已不存在的縮圖，
   * 點下去開不起檢視器。
   * 移除有三條路徑（上傳成功、檢視器刪除、多選刪除），集中在這裡才不會漏。
   */
  function removePhoto(id) {
    return App.db.remove(id).then(function () {
      // notifyRemoved 會重畫拍照頁的相簿，
      // 上傳成功、單張刪除、多選刪除三條路徑都會走到這裡
      if (App.camera && App.camera.notifyRemoved) { App.camera.notifyRemoved(id); }
    });
  }

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
    // 使用者按過取消就不再自動排程。擋在這裡而不是各個呼叫端——
    // 排程入口有好幾處（flush 收尾、恢復連線、回到前景），
    // 分散判斷遲早漏掉一條，那條就會讓「取消」失效。
    if (autoRetryPaused) return;

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

  /**
   * 把技術性錯誤轉成現場看得懂的說法。
   *
   * 這些訊息會顯示在照片的「上次失敗」欄位，現場人員看到
   * 「Error preparing Blob/File data to be stored in object store」
   * 只會困惑，不知道照片還在不在、要不要重拍。
   */
  function friendlyError(err) {
    var m = (err && err.message) ? String(err.message) : String(err);
    if (/Blob|File data|object store/i.test(m)) {
      return '照片暫時讀不到（系統回收記憶體），會自動重試';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return '網路不穩，會自動重送';
    }
    if (/timeout|逾時/i.test(m)) {
      return '連線逾時，會自動重送';
    }
    return m;
  }

  function uploadOne(rec) {
    // ⚠️ 上傳前【重新讀取】這筆記錄，不直接用傳進來的 rec.blob。
    //
    // 真兇：iOS 會在背景回收 blob 的記憶體參照。rec 來自 flush 開頭的
    // App.db.all()，整批送出時排在後面的那幾筆可能已經放了很久，
    // 此時 FileReader 讀它會拋「Error preparing Blob/File data to be
    // stored in object store」，但下一輪重試重新讀出來又是好的——
    // 症狀就是「一直重送、最後某次突然成功」。
    //
    // 重讀成本很低（IndexedDB 本地讀取），換來的是不必靠運氣重試。
    return App.db.get(rec.id).then(function (fresh) {
      // 已被刪除或上傳成功而移除：視為完成，不再送
      if (!fresh) { return null; }
      if (!(fresh.blob instanceof Blob)) {
        throw new Error('照片資料遺失，請刪除此筆後重拍');
      }
      return blobToBase64(fresh.blob);
    }).then(function (b64) {
      if (b64 === null) { return null; }   // 記錄已不存在
      return App.api.upload(App.auth.token(), rec, b64);
    }).then(function (resp) {
      if (resp === null) { return; }       // 記錄已不存在，無需後續處理
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
      return removePhoto(rec.id);
    });
  }

  /**
   * 每送完一張就更新畫面。
   *
   * 不能只在整批結束後更新——一次傳 9 張時，計數會整整卡住不動，
   * 使用者看不出到底有沒有在動（實際回報過的狀況）。
   * 佇列分頁沒開著時只更新數字徽章，省下重繪縮圖的成本。
   */
  /**
   * 把已送出的那一張從畫面上移除。
   *
   * 傳送過程中不重繪整個 grid——重繪要撤銷並重建所有 objectURL，
   * 密集呼叫時多次 render 會互相踩到彼此的 URL（見 render 的說明）。
   * 但完全不動畫面又會讓照片「整批傳完才一次消失」，過程中毫無進度感。
   *
   * 折衷：只把送掉的那一格抽掉，其餘的 DOM 與 URL 完全不動。
   */
  function removeThumb(id) {
    var grid = $('grid');
    if (!grid) return;
    var div = grid.querySelector('.thumb[data-id="' + id + '"]');
    if (!div) return;

    // 淡出後移除，讓使用者看得出「這張送掉了」而不是憑空消失
    div.classList.add('sent-out');
    setTimeout(function () {
      if (div.parentNode) { div.parentNode.removeChild(div); }
      // 全部送完時把空狀態叫出來
      if (!grid.children.length) {
        var empty = $('queueEmpty');
        if (empty) empty.style.display = 'block';
      }
    }, 260);
  }

  /** 就地更新某一張的重試次數徽章，不重繪整個 grid */
  function updateThumbBadge(id, retryCount) {
    var grid = $('grid');
    if (!grid) return;
    var div = grid.querySelector('.thumb[data-id="' + id + '"]');
    if (!div) return;
    var badge = div.querySelector('.up-badge');
    if (!badge) return;
    badge.className = 'up-badge ' + (retryCount > 0 ? 'error' : 'pending');
    badge.textContent = retryCount > 0 ? '!' + retryCount : '⤴';
  }

  function tick(light) {
    return refreshBadge().then(function () {
      // 目錄浮層開著時，讓各目錄的 (張數) 跟著往下掉
      if (App.tree.isSheetOpen()) {
        return App.tree.refreshCounts().then(App.tree.render);
      }
    }).then(function () {
      // light=true：傳送過程中呼叫，畫面由 removeThumb 逐張處理，
      // 不在這裡重繪整個 grid。
      if (light) { return; }
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
    // 取消後的自動重送（恢復連線、回到前景、重試計時器）一律不放行；
    // 使用者按「傳送」是 silent=false，不受此限。
    if (silent && autoRetryPaused) return Promise.resolve();

    var manual = !silent;
    if (manual && retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    // 使用者親自按「傳送」＝明確要送，解除先前取消造成的自動重送暫停。
    // 只有手動才解除：自動重送不該推翻使用者「停」的決定。
    if (manual) { autoRetryPaused = false; }

    flushing = true;
    cancelRequested = false;      // 每次開始傳送都重置，否則上一輪的取消會殘留
    var ok = 0, fail = 0, authFailed = false, cancelled = false;

    // 反向情況：已在選取模式時傳送啟動了（例如自動重送、恢復連線續送）。
    // 選取列還開著會讓人以為刪得掉，實際上刪除已被擋下，直接退出比較誠實。
    if (selecting) { exitSelect(); }

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
            // 這張已送出：只把它那一格抽掉，不重繪整個 grid
            removeThumb(rec.id);
            return tick(true);
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
            rec.lastError = friendlyError(err);
            rec.lastTryAt = Date.now();
            return App.db.patch(rec.id, {
              retryCount: rec.retryCount,
              lastError: rec.lastError,
              lastTryAt: rec.lastTryAt
            }).then(function () {
              // 失敗的那張就地更新重試次數徽章，同樣不重繪整個 grid
              updateThumbBadge(rec.id, rec.retryCount);
              return tick(true);
            });
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
      // 技術性訊息對現場人員沒有意義（例如 IndexedDB 的
      // 「Error preparing Blob/File data...」），只講後果與該怎麼辦。
      // 完整訊息仍寫進 console，排查時看得到。
      console.error('[queue] flush 失敗', err);
      toast('傳送中斷，未送出的照片仍保留在本機，稍後會自動重送');
    }).finally(function () {
      // 先解鎖再更新畫面，否則「傳送」鍵會停在 disabled
      // （refreshBadge 是依 flushing 決定按鈕狀態的）
      flushing = false;
      cancelRequested = false;
      // 還有沒送掉的就排下一輪；全部送完 scheduleRetry 會自行關掉旗標。
      //
      // ⚠️ 但使用者按過取消就【不排】。原本無條件 scheduleRetry()，
      //    取消後約 5 秒又自動開始，flushing 再度變 true，於是傳送鍵
      //    顯示「傳送」（看起來停了）卻擋住「選取」說傳送中——自相矛盾。
      //    要再送請使用者自己按「傳送」，那才是明確的意圖。
      if (!autoRetryPaused) { scheduleRetry(); }
      return tick();
    });
  }

  function revokeURLs() {
    objectURLs.forEach(function (u) { URL.revokeObjectURL(u); });
    objectURLs = [];
  }

  /**
   * 縮圖的預覽網址讀不到時的替代畫面。
   *
   * ⚠️ 刻意【不用警示色、不寫「失敗」】。
   *    這裡壞掉的只是 objectURL，IndexedDB 裡的 blob 完好無損——
   *    上傳走的是 App.db.get() 重讀，跟這個網址是兩條路，
   *    所以這些照片【照樣會正常傳完】（使用者實測確認過）。
   *    先前顯示紅字「預覽讀取失敗」會讓人以為照片壞了、想刪掉重拍，
   *    那才是真正的損失。
   *
   *    真的沒有 blob（照片資料遺失）才用警示色，見 render() 的 else 分支。
   */
  function showPreviewUnavailable(div, img) {
    if (img) img.remove();
    var w = document.createElement('div');
    w.className = 'thumb-nopreview';
    w.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.7l1.4-2h6.8l1.4 2h2.7A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
      '<circle cx="12" cy="12.8" r="3.4"/></svg>' +
      '<span>預覽暫時無法顯示<br>不影響上傳</span>';
    div.insertBefore(w, div.firstChild);
  }

  // 渲染世代編號。傳送時 tick() 每送完一張就呼叫 render()，
  // 密集觸發會讓多次 render 重疊執行（見下方說明）。
  var renderSeq = 0;

  function render() {
    // ⚠️ 這裡的競態會讓【整頁縮圖同時變成「預覽讀取失敗」】。
    //
    // render 的 App.db.all() 是非同步的。連續呼叫時：
    //   A 開始 → all() 等待中
    //   B 開始 → all() 等待中
    //   A 回來 → revokeURLs() 清空、建立新 URL、掛上 DOM
    //   B 回來 → revokeURLs() 把 A 剛建立的 URL 全部撤銷！
    //            但 DOM 上的 <img src> 還指著它們 → 全部載入失敗
    //
    // 症狀正是「按下傳送就全部跳預覽失敗，等自動重送後又恢復」——
    // 傳送會密集觸發 tick()，自動重送時 render 只跑一次就不會重疊。
    //
    // 用世代編號讓過期的渲染直接放棄，只有最新的那次能動 DOM 與 URL。
    var seq = ++renderSeq;

    return App.db.all().then(function (recs) {
      if (seq !== renderSeq) { return; }   // 已有更新的 render 接手，放棄本次

      var grid = $('grid');
      revokeURLs();
      grid.innerHTML = '';
      grid.classList.toggle('selecting', selecting);

      recs.sort(function (a, b) {
        return new Date(b.capturedAt) - new Date(a.capturedAt);
      });

      $('queueEmpty').style.display = recs.length ? 'none' : 'block';

      recs.forEach(function (r) {
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
          // ⚠️ 載入失敗先【重讀 IndexedDB 重試一次】，不要立刻判定破圖。
          //
          // 真兇：iOS Safari 在 App 切到背景／螢幕關閉時會回收 blob 資源，
          // 回到前景後既有的 objectURL 就失效了，但 IndexedDB 裡的 blob
          // 完好無損——所以那些照片傳出去的檔案是正常的，壞的只是預覽網址。
          // 現場症狀：離線一段時間回來，部分縮圖變成「預覽讀取失敗」。
          //
          // 重讀一次拿到新的 blob 再產生新 URL 即可救回；真的讀不到才報錯。
          img.onerror = function () {
            // 已有更新的 render 接手就不必救了——這個 img 馬上會被換掉，
            // 硬救反而會把新 URL 推進即將被撤銷的清單裡。
            if (seq !== renderSeq) { return; }
            App.db.get(r.id).then(function (fresh) {
              if (seq !== renderSeq) { return; }
              if (!fresh || !(fresh.blob instanceof Blob)) { throw new Error('no blob'); }
              var url2 = URL.createObjectURL(fresh.blob);
              objectURLs.push(url2);
              // 第二次仍失敗才顯示替代畫面，避免無限重試
              img.onerror = function () { showPreviewUnavailable(div, img); };
              img.src = url2;
            }).catch(function () {
              showPreviewUnavailable(div, img);
            });
          };
        } else {
          // 這才是真的有問題（IndexedDB 裡沒有 blob），用警示色。
          // 與上面的「預覽暫時無法顯示」不同：那個檔案是好的，只是網址失效。
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

        // 拖曳框選要靠 elementFromPoint 反查手指下方是哪一張，
        // 把 id 掛在 DOM 上比維護一份座標表可靠——版面會隨螢幕寬度重排。
        div.dataset.id = r.id;

        if (selecting) {
          var isPicked = !!picked[r.id];
          if (isPicked) div.classList.add('picked');
          var pick = document.createElement('div');
          pick.className = 'pick';
          pick.textContent = isPicked ? '✓' : '';
          bindDragPick(pick, r.id);
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

      // ⚠️ queueInfo 不在這裡寫，改由 refreshBadge 統一更新。
      //    傳送中 tick(light) 會跳過 render（避開 objectURL 競態），
      //    寫在這裡就不會更新，畫面會出現「工具列說 3 張、分頁說 2 張」
      //    的矛盾，讓人以為有一張卡住沒送。
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

  /**
   * 從佇列【以外】的地方打開檢視器（目前是拍照頁）。
   *
   * viewList 平常只由 render() 建立，而 render() 只在佇列頁跑；
   * 直接呼叫 openViewer 會因為 viewList 是空的而開不起來。
   *
   * @param id      要看哪一張
   * @param single  true = 只看這一張（拍完立即檢視）。
   *                拍完馬上跳出來是要「確認這張拍得清不清楚」，
   *                此時把整個佇列排進序列，手滑一滑就跑到別張，
   *                使用者會分不清現在確認的是不是剛拍的那張。
   *                false = 整個佇列都排進來，可左右滑瀏覽。
   */
  function openViewerById(id, single) {
    if (single) {
      viewList = [id];
      openViewer(id);
      return Promise.resolve();
    }
    return App.db.all().then(function (recs) {
      recs.sort(function (a, b) {
        return new Date(b.capturedAt) - new Date(a.capturedAt);
      });
      viewList = recs.map(function (r) { return r.id; });
      openViewer(id);
    });
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

    removePhoto(id).then(function () {
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

      // 分頁副標顯示張數與總容量：拍照頁不再有提示條，
      // 這裡是使用者唯一能不切頁就看到「累積多少」的地方。
      var totalSize = 0;
      recs.forEach(function (r) { totalSize += r.size || 0; });
      var sub = $('queueSub');
      if (sub) {
        sub.textContent = recs.length
          ? (recs.length + ' 張 · ' + App.util.fmtSize(totalSize))
          : '';
      }

      // 佇列頁工具列的張數也在這裡寫，與上面的徽章【同一次讀取】。
      // 分開在 render 寫的話，傳送中 tick(light) 跳過 render，
      // 兩個數字就會對不起來（實際回報過：工具列 3 張、分頁 2 張）。
      var info = $('queueInfo');
      if (info) {
        info.textContent = recs.length
          ? (recs.length + ' 張待上傳 · ' + App.util.fmtSize(totalSize))
          : '佇列已清空';
      }

      var bar = $('sendBar');
      if (!bar) return;
      if (!recs.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';

      var pending = pendingOf(recs);
      var waiting = pending.filter(function (r) { return !isConfirmed(r); });
      var sending = pending.filter(isConfirmed);

      var wSize = 0;
      waiting.forEach(function (r) { wSize += r.size || 0; });
      var failed = pending.filter(function (r) { return r.retryCount > 0; }).length;

      var btn = $('sendNowBtn');

      // 傳送中把「選取」停用並變灰，讓使用者一眼看出不能選，
      // 而不是按下去才被 toast 擋回來。放在 flushing 分支之前——
      // 那個分支會提早 return。
      var selBtn = $('selectModeBtn');
      if (selBtn) {
        selBtn.disabled = flushing;
        selBtn.title = flushing ? '傳送中無法選取' : '';
      }

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
    // 停掉自動重送，否則 finally 的 scheduleRetry 會在幾秒後又自己開始，
    // 使用者會發現「明明取消了卻還在傳」
    autoRetryPaused = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    toast('已停止傳送，未送出的會保留在本機');
    refreshBadge();
  }

  /* ---------- 多選刪除 ---------- */

  function pickedIds() { return Object.keys(picked); }

  function updateSelectUI() {
    var n = pickedIds().length;
    var info = $('selectInfo');
    var del = $('deleteSelBtn');
    if (info) info.textContent = '已選 ' + n + ' 張';
    if (del) del.disabled = (n === 0);
  }

  function enterSelect() {
    // 傳送中不給進選取模式。
    // 刪除本來就被擋（正在送的那張被刪會讓 uploadOne 拿到失效記錄），
    // 讓使用者選了一輪才發現不能刪，不如一開始就說清楚。
    if (flushing) {
      toast('傳送中無法選取，請先按「取消傳送」');
      return Promise.resolve();
    }
    selecting = true;
    picked = {};
    var bar = $('selectBar'), btn = $('selectModeBtn');
    if (bar) bar.style.display = 'flex';
    if (btn) btn.style.display = 'none';
    updateSelectUI();
    return render();
  }

  function exitSelect() {
    selecting = false;
    picked = {};
    var bar = $('selectBar'), btn = $('selectModeBtn');
    if (bar) bar.style.display = 'none';
    if (btn) btn.style.display = '';
    return render();
  }

  function togglePick(id) {
    if (picked[id]) { delete picked[id]; } else { picked[id] = true; }
    updateSelectUI();
    return render();
  }

  /**
   * 只更新單一縮圖的勾選外觀，不重繪整個 grid。
   *
   * 拖曳過程每經過一張就 render() 會重建所有 DOM 與 objectURL，
   * 在幾十張照片時明顯卡頓，手指還會因為節點被抽換而中斷拖曳。
   */
  function paintPick(id, on) {
    var div = $('grid').querySelector('.thumb[data-id="' + id + '"]');
    if (!div) return;
    div.classList.toggle('picked', on);
    var pick = div.querySelector('.pick');
    if (pick) pick.textContent = on ? '✓' : '';
  }

  /**
   * 從勾選框開始拖曳＝框選；從縮圖其他位置滑動＝正常捲動頁面。
   *
   * 這個分工是刻意的：整區禁止捲動的話，照片多於一螢幕時就看不到下面的，
   * 得再做「拖到邊緣自動捲動」才能用，複雜度高很多。
   *
   * 拖過的一律【選上】，不做反向取消——起點狀態決定選或不選的話，
   * 使用者很難預測拖到一半的結果，越拖越亂。
   */
  function bindDragPick(pickEl, id) {
    pickEl.addEventListener('touchstart', function (ev) {
      // 阻止捲動與後續的 click（否則放開手指會再 toggle 一次，把剛選的取消掉）
      ev.preventDefault();
      ev.stopPropagation();

      dragging = true;
      dragTouched = {};

      applyDrag(id);

      var move = function (e) {
        if (!dragging) return;
        e.preventDefault();
        var t = e.touches && e.touches[0];
        if (!t) return;
        var el = document.elementFromPoint(t.clientX, t.clientY);
        if (!el) return;
        var thumb = el.closest ? el.closest('.thumb') : null;
        if (thumb && thumb.dataset.id) applyDrag(thumb.dataset.id);
      };

      var end = function () {
        dragging = false;
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', end);
        document.removeEventListener('touchcancel', end);
        // 拖曳結束才做一次完整更新，把計數與畫面對齊
        updateSelectUI();
      };

      // passive:false 才擋得住捲動——行動瀏覽器預設把 touchmove 當被動監聽
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', end);
      document.addEventListener('touchcancel', end);
    }, { passive: false });

    // 桌機（現場也可能用平板接滑鼠、或在 PC 上操作）
    pickEl.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      dragging = true;
      dragTouched = {};
      applyDrag(id);

      var move = function (e) {
        if (!dragging) return;
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        var thumb = el.closest ? el.closest('.thumb') : null;
        if (thumb && thumb.dataset.id) applyDrag(thumb.dataset.id);
      };
      var end = function () {
        dragging = false;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', end);
        updateSelectUI();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', end);
    });
  }

  /** 拖曳經過某張：一律選上，同一張只處理一次 */
  function applyDrag(id) {
    if (dragTouched[id]) return;
    dragTouched[id] = true;
    if (!picked[id]) {
      picked[id] = true;
      paintPick(id, true);
    }
    updateSelectUI();
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
      return chain.then(function () { return removePhoto(id); });
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
    // ⚠️ 一律用 on() 綁定，不可寫成 $('id').onclick = ...
    //    Service Worker 曾讓 js 已更新、index.html 仍是快取舊版，
    //    此時元素為 null，直接設 onclick 會拋 TypeError 中斷整個 init()，
    //    連後面的 online 監聽都綁不上（v10 的複選功能就是這樣整組失效的）。
    function on(id, fn) {
      var el = $(id);
      if (el) { el.onclick = fn; }
      else { console.warn('[queue] 找不到元素 ' + id + '，前端可能是舊版快取'); }
    }

    // 同一顆按鈕三種行為：閒置時送出／重試、傳送中則取消。
    // 文案由 refreshBadge 依狀態切換為「傳送」「立即重試」「取消傳送」。
    on('sendNowBtn', function () {
      if (flushing) { cancelFlush(); } else { flush(false); }
    });

    on('selectModeBtn', function () { enterSelect(); });
    on('selectCancelBtn', function () { exitSelect(); });
    on('deleteSelBtn', function () { deletePicked(); });

    on('selectAllBtn', function () {
      App.db.all().then(function (recs) {
        // 全部已選就取消全選，否則全選——同一顆鍵兩用，省一個按鈕
        var all = recs.length > 0 && recs.every(function (r) { return picked[r.id]; });
        picked = {};
        if (!all) { recs.forEach(function (r) { picked[r.id] = true; }); }
        updateSelectUI();
        return render();
      });
    });

    // 恢復連線：只續送【已確認】的那些；未確認的只提示，不偷跑
    //（使用者可能還在拍、或正要刪掉拍壞的那幾張）。
    // 回到前景時重繪整個佇列，把失效的 objectURL 一次全換掉。
    // iOS 在背景會回收 blob 資源（見上方 img.onerror 的說明），
    // 不主動重繪的話，使用者會先看到一整片「預覽讀取失敗」才逐張救回。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if ($('queueView').classList.contains('active')) { render(); }
    });

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
    exitSelect: exitSelect, isSelecting: function () { return selecting; },
    openViewerById: openViewerById
  };
})();
