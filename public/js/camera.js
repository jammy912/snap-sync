/* camera.js — 兩種取像方式 + 縮圖壓縮
 *
 * 【兩種模式並存，各有取捨】
 *
 * 1. 系統相機（快門鍵，input[capture]）
 *    叫出手機原生相機。閃光燈的關／開／自動是 Apple／Google 自己的介面，
 *    順便白拿原廠的對焦與 HDR。代價：每張要多按一次「使用照片」，連拍慢。
 *
 * 2. 即時拍照（快門右邊的相機鍵，getUserMedia）
 *    App 內預覽，按快門直接抓一格，連拍流暢。
 *    閃光燈用 track.applyConstraints({ advanced: [{ torch: true }] })。
 *
 * ⚠️ 修正錯誤認知（2026-08-19 實機驗證）：
 *    我先前在多處註解與 commit 訊息裡寫「iOS Safari 沒有實作 torch，
 *    getCapabilities() 不回傳該欄位」——【這是錯的】。
 *    使用者以 iPhone 實測：即時拍照的閃電鍵會出現且按下去真的會亮。
 *    torchBtn 只在 getCapabilities().torch 為真時才顯示，能亮就代表
 *    WebKit 有支援（Safari 16.4+ 起）。
 *    → 不要再假設「iOS 一定沒有 torch」。一律以 getCapabilities() 的
 *      實際回報為準，這也是本檔 hasTorch() 的作法（本來就正確，
 *      錯的只有註解）。
 *
 * 拍照後【一律先寫入本機佇列】再嘗試上傳，絕不「傳成功才存」——
 * 否則弱網環境下照片會直接消失。
 */
'use strict';

var App = window.App || {};
window.App = App;

App.camera = (function () {
  var $ = App.util.$;
  var toast = App.util.toast;

  var busy = false;      // 縮圖處理中，擋住重複按快門

  /**
   * 快門的啟用狀態。
   *
   * ⚠️ 相機沒開就【不能按】——這是刻意的。
   *    相機關著時中間顯示的是相簿（已拍過的照片），此時快門若能按，
   *    使用者會以為拍到了，其實什麼都沒發生。停用讓「要先開相機」
   *    這件事一目了然。
   */
  function refreshShutterState() {
    $('shutterBtn').disabled = !liveOn() || !App.tree.selectedPath() || busy;
  }

  /** 按快門＝從即時預覽抓一格 */
  function shoot() {
    if (busy) return;
    if (!liveOn()) { toast('請先按右邊的相機鍵開啟相機'); return; }
    if (!App.tree.selectedPath()) {
      toast('請先選擇上傳目錄');
      App.tree.openSheet();
      return;
    }
    captureLive();
  }

  /** 把壓好的照片寫進佇列並更新畫面 */
  function saveShot(blob, w, h, target, capturedAt) {
    var id = App.util.uuid();
    var rec = {
      id: id,
      targetPath: target,
      fileName: App.util.stampForName(capturedAt) + '_' + id.slice(0, 8) + '.jpg',
      capturedAt: capturedAt,
      blob: blob,
      w: w, h: h,
      size: blob.size,
      status: 'pending',
      retryCount: 0,
      lastError: ''
    };

    return App.db.add(rec).then(function () {
      lastId = id;
      renderStrip(id);    // 立刻跳到新拍的這張

      // 拍完再自動跳出全螢幕檢視器（預設關閉）。
      // 上一行的 renderStrip 已經把這張顯示在中間整片大圖了，
      // 通常不必再疊一層；要更大或想直接刪除的人才開這個設定。
      // 只排這一張（single=true）：此刻要確認的是「剛拍的這張」，
      // 排進整個佇列的話手一滑就跑到別張，反而分不清在看哪一張。
      if (App.app.settings().autoReview === true) {
        App.queue.openViewerById(id, true);
      }

      // 只講最後一層目錄與大小，維持單行。
      // 完整路徑已常駐在上方的「上傳至」列，這裡重複只會把 toast 撐成兩行。
      var parts = target.split('/');
      toast('已存至 ' + parts[parts.length - 1] + ' · ' + App.util.fmtSize(blob.size));
      // 【不自動上傳】拍完只入佇列，等使用者確認完按「傳送」才送。
      // 原本拍一張就送一張，會在連拍時邊拍邊佔網路，
      // 也讓「拍錯想刪掉重拍」變得來不及——照片早就上雲端了。
      App.queue.refreshBadge();
    }).catch(function (e) {
      toast('儲存失敗：' + e.message);
    });
  }

  /* ---------- 即時拍照（App 內預覽，Android 可開閃光燈）---------- */

  // 閃光燈：track.applyConstraints({ advanced: [{ torch: true }] })。
  // 支不支援【一律問 getCapabilities()】，不要用平台判斷——
  // iOS 實測是會亮的（見檔頭的「修正錯誤認知」）。
  var stream = null;
  var track = null;
  var torchOn = false;
  // 固定後鏡頭：現場拍的是設備與環境，自拍鏡頭用不到（也沒有閃光燈）。
  var FACING = 'environment';

  function liveOn() { return !!stream; }

  /** 這支裝置／這顆鏡頭支不支援閃光燈 */
  function hasTorch() {
    if (!track || !track.getCapabilities) return false;
    try { return !!track.getCapabilities().torch; } catch (e) { return false; }
  }

  function startLive() {
    stopLive();
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: FACING }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      stream = s;
      track = s.getVideoTracks()[0] || null;
      torchOn = false;

      var v = $('video');
      v.srcObject = s;
      $('liveWrap').style.display = 'flex';
      $('albumWrap').style.display = 'none';
      $('camHint').style.display = 'none';
      refreshLiveUI();
      refreshShutterState();

      // ⚠️ 部分裝置在 track 剛拿到時 getCapabilities() 還是空的，
      //    此時問 torch 會得到「不支援」而把閃光燈鍵藏起來（其實有）。
      //    等串流真的開始播放後再問一次，補顯示那顆鍵。
      var again = function () { refreshLiveUI(); };
      v.addEventListener('loadedmetadata', again, { once: true });
      setTimeout(again, 500);
    }).catch(function (e) {
      toast('無法開啟相機：' + (e.message || e.name));
      stopLive();
      refreshShutterState();
    });
  }

  function stopLive() {
    // 一定要 stop 每一條 track，否則相機燈號會一直亮著、也擋住其他 App 用相機
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
    stream = null; track = null; torchOn = false;

    var v = $('video');
    if (v) { v.srcObject = null; }
    var lw = $('liveWrap');
    if (lw) lw.style.display = 'none';

    // ⚠️ UI 更新放在這裡，不要放在各個呼叫端。
    //    關相機有四條路徑（按鍵、切分頁、進背景、登出、開啟失敗），
    //    分散處理遲早漏掉一條，那條就會留著「關閉相機」的圖示與閃光燈鍵。
    refreshLiveUI();
  }

  /** 關掉即時拍照，回到相簿 */
  function exitLive() {
    stopLive();
    refreshShutterState();
    return renderStrip();
  }

  // 相機鍵的兩種圖示。用 currentColor 描邊，跟著按鈕狀態變色。
  // 相機（按了會開啟）
  var ICON_CAM_ON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.7l1.4-2h6.8l1.4 2h2.7A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
    '<circle cx="12" cy="12.8" r="3.4"/></svg>';
  // 相機加一條斜線（按了會關閉，回到相簿）
  var ICON_CAM_OFF =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.7l1.4-2h6.8l1.4 2h2.7A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
    '<circle cx="12" cy="12.8" r="3.4"/>' +
    '<path d="M4 20 20 4"/></svg>';

  function refreshLiveUI() {
    var on = liveOn();

    // 閃光燈鍵在下方控制列，只在相機開著且該鏡頭真的有燈時才出現。
    // 相機關著時中間是相簿，留著一顆按了沒反應的閃電只會讓人困惑。
    var t = $('torchBtn');
    if (t) {
      t.style.display = (on && hasTorch()) ? 'flex' : 'none';
      t.classList.toggle('is-on', torchOn);
      t.setAttribute('aria-pressed', torchOn ? 'true' : 'false');
    }

    // 相機鍵：圖示【依當下狀態顯示要做的動作】。
    // 關著→相機圖示（按了會開）；開著→關閉相機圖示（按了會關、回相簿）。
    // 只靠顏色區分不夠，現場強光下看不出亮暗差異。
    var lb = $('liveBtn');
    if (lb) {
      lb.classList.toggle('is-on', on);
      lb.setAttribute('aria-pressed', on ? 'true' : 'false');
      lb.title = on ? '關閉相機（回相簿）' : '開啟相機';
      lb.setAttribute('aria-label', on ? '關閉相機' : '開啟相機');
      lb.innerHTML = on ? ICON_CAM_OFF : ICON_CAM_ON;
    }
  }

  function toggleTorch() {
    if (!track || !hasTorch()) { toast('這支裝置不支援閃光燈'); return; }
    var next = !torchOn;
    track.applyConstraints({ advanced: [{ torch: next }] }).then(function () {
      torchOn = next;
      refreshLiveUI();
    }).catch(function (e) {
      toast('閃光燈切換失敗：' + (e.message || e.name));
    });
  }

  /**
   * 按下快門時畫面白閃一下（相機的拍照感）。
   *
   * 不只是好看：存檔是非同步的，沒有回饋的話使用者不確定到底拍到沒有，
   * 就會多按幾次變成重複照片。閃一下是【當下立刻】看得到的確認，
   * 比等 toast 跳出來快。
   *
   * ⚠️ 用 CSS animation 而非 setTimeout 改樣式：
   *    連拍時前一次的計時器會蓋掉後一次。這裡每次都把節點抽掉重加，
   *    強制動畫從頭播放，連續按也每張都閃。
   */
  function flashScreen() {
    var el = $('camFlash');
    if (!el) return;
    el.classList.remove('on');
    void el.offsetWidth;      // 強制 reflow，動畫才會重新開始
    el.classList.add('on');
  }

  /** 即時拍照的快門：從 video 抓一格畫面 */
  function captureLive() {
    var v = $('video');
    if (!v || !v.videoWidth) { toast('相機尚未就緒'); return; }

    var target = App.tree.selectedPath();
    if (!target) { toast('請先選擇上傳目錄'); App.tree.openSheet(); return; }

    var capturedAt = new Date().toISOString();
    var w = v.videoWidth, h = v.videoHeight;
    var st = App.app.settings();
    if (Math.max(w, h) > st.maxEdge) {
      var scale = st.maxEdge / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    var c = $('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);

    flashScreen();      // 畫面閃一下，讓人知道「這一張拍下去了」

    busy = true;
    refreshShutterState();
    c.toBlob(function (blob) {
      if (!blob) { busy = false; refreshShutterState(); toast('拍照失敗'); return; }
      saveShot(blob, w, h, target, capturedAt).then(function () {
        busy = false;
        refreshShutterState();
      }, function () {
        busy = false;
        refreshShutterState();
      });
    }, 'image/jpeg', st.quality);
  }

  /* ---------- 相簿：一次一張大圖，左右滑換張 ---------- */

  // ⚠️ 這個 URL 必須【自己管】，不可共用 queue 的 objectURLs。
  //    queue.render() 會 revoke 掉它那批的全部；共用的話，佇列頁一重繪
  //    （傳送時會密集觸發）就把這裡的網址一起撤銷，照片變破圖。
  //    那正是先前「整頁縮圖同時變成預覽讀取失敗」的同一類競態。
  //
  //    只保留【當前這一張】的 URL。不做縮圖、不預先產生整批，
  //    36 張全開 objectURL 會白佔記憶體，手機上更明顯。
  var shotURL = null;
  var stripSeq = 0;

  var album = [];         // 目前的照片序列（新的在前）
  var albumIdx = 0;       // 正在看第幾張
  var lastId = null;      // 剛拍的那張，換張後仍記著它是哪一張

  function revokeStrip() {
    if (shotURL) { URL.revokeObjectURL(shotURL); shotURL = null; }
  }

  /** 把第 idx 張畫到畫面上（不重讀資料庫） */
  function paint(idx) {
    if (!album.length) return;
    albumIdx = Math.max(0, Math.min(idx, album.length - 1));
    var r = album[albumIdx];

    revokeStrip();
    var img = $('albumImg');
    if (r.blob instanceof Blob) {
      shotURL = URL.createObjectURL(r.blob);
      img.src = shotURL;
      img.style.display = 'block';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
    }

    // 路徑：內容給完整的，由 CSS 單行截斷【前段】保留末層目錄
    // （bdi 的用途見 app.css 的 .album-path 與「上傳至」列的說明）。
    // 不用 innerHTML 拼字串——目錄名稱來自伺服器，直接拼會有 XSS 風險。
    var full = r.targetPath || '—';
    var cap = $('albumPath');
    cap.textContent = '';
    var bdi = document.createElement('bdi');
    bdi.setAttribute('dir', 'ltr');
    bdi.textContent = full;
    cap.appendChild(bdi);
    cap.title = full;

    $('albumPos').textContent = (albumIdx + 1) + '/' + album.length
      + (r.id === lastId ? '（剛拍）' : '');

    var b = $('albumBadge');
    b.style.display = r.retryCount > 0 ? 'inline-block' : 'none';
    b.textContent = '重試 ' + r.retryCount;

    $('albumPrev').disabled = (albumIdx <= 0);
    $('albumNext').disabled = (albumIdx >= album.length - 1);
  }

  function showAt(idx) { paint(idx); }

  /**
   * 重讀佇列並顯示。
   * 進到拍照頁就看得到已經拍了哪些，不必切分頁確認。
   * @param focusId 指定要停在哪一張（拍完停在新拍的那張）
   */
  function renderStrip(focusId) {
    var img = $('albumImg');
    if (!img) return Promise.resolve();

    // 世代編號：連拍時會密集呼叫，過期的那次不可動 DOM 與 URL
    var seq = ++stripSeq;

    return App.db.all().then(function (recs) {
      if (seq !== stripSeq) { return; }

      recs.sort(function (a, b) {
        return new Date(b.capturedAt) - new Date(a.capturedAt);
      });
      album = recs;

      // ⚠️ 即時拍照開著時只更新資料，不可動版面。
      //    saveShot 每拍一張都會呼叫這裡；不擋的話相簿會蓋掉即時預覽，
      //    連拍時每按一次快門就被踢出即時模式一次。
      //    序列已更新，關掉即時拍照時 renderStrip 會再跑一次把畫面補上。
      if (liveOn()) {
        albumIdx = 0;
        var lc = $('liveCount');
        if (lc) { lc.textContent = recs.length ? '已拍 ' + recs.length + ' 張' : ''; }
        return;
      }

      var wrap = $('albumWrap');
      var hint = $('camHint');
      if (!recs.length) {
        revokeStrip();
        if (wrap) wrap.style.display = 'none';
        if (hint) hint.style.display = 'block';
        img.removeAttribute('src');
        albumIdx = 0;
        return;
      }
      if (wrap) wrap.style.display = 'flex';
      if (hint) hint.style.display = 'none';

      // 停在指定那張；沒指定就儘量停在原本看的位置（刪掉後不會亂跳）
      var at = 0;
      if (focusId) {
        for (var i = 0; i < recs.length; i++) { if (recs[i].id === focusId) { at = i; break; } }
      } else {
        at = Math.min(albumIdx, recs.length - 1);
      }
      paint(at);
    });
  }

  /**
   * 照片被刪掉了（或已上傳成功而移除），相簿要跟著重讀，
   * 不然會停在一張已不存在的照片上。
   */
  function notifyRemoved(id) {
    if (id && id === lastId) { lastId = null; }
    renderStrip();
  }

  /** 登出時清空相簿，換人登入不該看到前一個人的照片 */
  function stop() {
    stopLive();          // 相機一定要關，否則登出後鏡頭燈號還亮著
    lastId = null;
    album = [];
    albumIdx = 0;
    revokeStrip();
    var img = $('albumImg');
    if (img) { img.removeAttribute('src'); }
    var wrap = $('albumWrap');
    if (wrap) wrap.style.display = 'none';
    var hint = $('camHint');
    if (hint) hint.style.display = 'block';
  }

  function init() {
    $('shutterBtn').onclick = shoot;

    // 相機鍵＝開關。開著就關掉回相簿，關著就開起來。
    // 同一顆鍵兩用，現場不必找「關閉」在哪裡。
    $('liveBtn').onclick = function () {
      if (liveOn()) { exitLive(); } else { startLive(); }
    };
    $('torchBtn').onclick = toggleTorch;

    // 切走分頁或 App 進背景就關相機：省電、放開鏡頭給別的 App，
    // 也避免使用者以為還在錄影。回來時停在相簿，要拍再按一次。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' && liveOn()) { exitLive(); }
    });

    $('albumPrev').onclick = function () { showAt(albumIdx - 1); };
    $('albumNext').onclick = function () { showAt(albumIdx + 1); };

    // 點照片開放大檢視（可再放大、刪除）
    $('albumImg').onclick = function () {
      if (!album.length) return;
      App.queue.openViewerById(album[albumIdx].id);
    };

    // 左右滑換張。
    // ⚠️ 用 touchstart/touchend 判斷位移，不接管捲動（passive:true）——
    //    這一區沒有可捲動的內容，攔下來只會讓瀏覽器少一次最佳化。
    var x0 = null, y0 = null;
    var stage = $('albumStage');
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { x0 = null; return; }
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      var dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      // 位移不夠、或縱向多於橫向（那是想捲動不是換張）就不動作
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
      showAt(dx < 0 ? albumIdx + 1 : albumIdx - 1);
    }, { passive: true });

    refreshShutterState();
  }

  return {
    init: init, stop: stop, refreshShutterState: refreshShutterState,
    notifyRemoved: notifyRemoved, renderStrip: renderStrip,
    exitLive: exitLive
  };
})();
