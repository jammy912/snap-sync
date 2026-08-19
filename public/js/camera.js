/* camera.js — 叫用系統相機、縮圖壓縮
 *
 * ⚠️ 為什麼不用 getUserMedia 自己做預覽？【因為閃光燈】
 *
 * 現場（工地暗處、管道間、天花板內部）沒有補光就拍不到東西，閃光燈是硬需求。
 * 但網頁控制閃光燈只有 Android Chrome 做得到：
 *     track.applyConstraints({ advanced: [{ torch: true }] })
 * iOS Safari 至今沒有實作 torch，getCapabilities() 根本不回傳這個欄位——
 * 不是權限問題也不是版本太舊，是 WebKit 沒做。螢幕補光的亮度在工地不夠用。
 *
 * 所以改成兩個平台【都叫系統相機】（input[capture]）：閃光燈的關／開／自動
 * 用手機原生相機的按鈕，順便白拿原廠的對焦與 HDR。
 * 代價是失去 App 內即時預覽，每張要多按一次「使用照片」——已與使用者確認接受。
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

  /** 未選目錄或正在處理上一張時，快門停用 */
  function refreshShutterState() {
    $('shutterBtn').disabled = !App.tree.selectedPath() || busy;
  }

  /** 按快門＝叫出系統相機 */
  function shoot() {
    if (busy) return;
    if (!App.tree.selectedPath()) {
      toast('請先選擇上傳目錄');
      App.tree.openSheet();
      return;
    }
    $('camInput').click();
  }

  /**
   * 系統相機回來了（使用者按取消則不會觸發本事件）。
   * 這裡起的壓縮、入庫流程與舊版 getUserMedia 版本完全相同，
   * 差別只在來源從 <video> 換成 File。
   */
  function onPicked(e) {
    var input = e.target;
    var file = input.files && input.files[0];

    // ⚠️ 必須清空，且要在讀完 file 之後。
    // 不清空的話，下一張若被 iOS 判定為「同一個檔案」就不會再觸發 change，
    // 快門按了完全沒反應（連拍時很容易踩到）。
    input.value = '';

    if (!file) return;

    // 拍照時間在這一刻取，與檔名時間戳共用同一個值，避免跨秒時兩者對不起來
    var capturedAt = new Date().toISOString();
    var target = App.tree.selectedPath();
    if (!target) { toast('請先選擇上傳目錄'); return; }

    busy = true;
    refreshShutterState();

    var url = URL.createObjectURL(file);
    var img = new Image();

    function done() {
      URL.revokeObjectURL(url);
      busy = false;
      refreshShutterState();
    }

    img.onerror = function () {
      done();
      toast('讀取照片失敗，請再拍一次');
    };

    img.onload = function () {
      // 系統相機是全解析度拍攝（可能 3~8MB），一定要縮圖再存。
      // 瀏覽器畫 <img> 時已套用 EXIF 方向，drawImage 出來的方向是正的。
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { img.onerror(); return; }

      var st = App.app.settings();
      var max = st.maxEdge;
      if (Math.max(w, h) > max) {
        var scale = max / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      var c = $('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);

      c.toBlob(function (blob) {
        if (!blob) { done(); toast('拍照失敗'); return; }
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

        App.db.add(rec).then(function () {
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
          done();
        }).catch(function (e) {
          done();
          toast('儲存失敗：' + e.message);
        });
      }, 'image/jpeg', st.quality);
    };

    img.src = url;
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

    // 路徑：從【後面】往前取三層。前面的「防治部/02桃園/相片」每張都一樣，
    // 從前面截斷會把真正能分辨目的地的葉目錄擠掉。
    var full = r.targetPath || '—';
    var segs = full.split('/');
    var cap = $('albumPath');
    cap.textContent = segs.length > 3 ? '…/' + segs.slice(-3).join('/') : full;
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
    $('camInput').onchange = onPicked;

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
    notifyRemoved: notifyRemoved, renderStrip: renderStrip
  };
})();
