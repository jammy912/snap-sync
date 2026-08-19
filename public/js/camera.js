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
          lastId = id;        // 相簿裡把這張框起來
          renderStrip();      // 新拍的那張要立刻出現在相簿

          // 拍完立即檢視（設定可關）。
          //
          // 現場最痛的是回辦公室才發現照片糊掉、或門牌沒入鏡，那時已經
          // 無法補拍。縮圖太小看不出對焦有沒有跑掉，一定要放大才看得準。
          // 只排這一張（single=true）：此刻要確認的是「剛拍的這張」，
          // 排進整個佇列的話手一滑就跑到別張，反而分不清在看哪一張。
          if (App.app.settings().autoReview !== false) {
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

  /* ---------- 相簿（拍照頁中間那一大片）---------- */

  // ⚠️ 這批 URL 必須【自己管】，不可共用 queue 的 objectURLs。
  //    queue.render() 會 revoke 掉它那批的全部；共用的話，佇列頁一重繪
  //    （傳送時會密集觸發）就把相簿的網址一起撤銷，這裡整片變破圖。
  //    那正是先前「整頁縮圖同時變成預覽讀取失敗」的同一類競態。
  var stripURLs = [];
  var stripSeq = 0;
  var lastId = null;      // 剛拍的那張，用主色框出來

  function revokeStrip() {
    stripURLs.forEach(function (u) { URL.revokeObjectURL(u); });
    stripURLs = [];
  }

  /**
   * 重畫相簿：把佇列裡的照片依拍攝時間（新的在前）排成格狀。
   * 進到拍照頁就看得到已經拍了哪些，不必切分頁確認。
   * 每張疊上【完整路徑】（過長自動換行），佇列裡混著多個目錄時
   * 才分得出這張要傳去哪。
   */
  function renderStrip() {
    var strip = $('camStrip');
    if (!strip) return Promise.resolve();

    // 世代編號：連拍時會密集呼叫，過期的那次不可動 DOM 與 URL
    var seq = ++stripSeq;

    return App.db.all().then(function (recs) {
      if (seq !== stripSeq) { return; }

      recs.sort(function (a, b) {
        return new Date(b.capturedAt) - new Date(a.capturedAt);
      });

      revokeStrip();
      strip.innerHTML = '';

      var head = $('albumHead');
      if (head) { head.style.display = recs.length ? 'flex' : 'none'; }
      var hint = $('camHint');
      if (hint) { hint.style.display = recs.length ? 'none' : 'block'; }

      recs.forEach(function (r) {
        if (!(r.blob instanceof Blob)) return;
        var url = URL.createObjectURL(r.blob);
        stripURLs.push(url);

        var cell = document.createElement('button');
        cell.className = 'album-cell' + (r.id === lastId ? ' is-last' : '');
        cell.type = 'button';

        var shot = document.createElement('span');
        shot.className = 'album-shot';
        var im = document.createElement('img');
        im.alt = '';
        im.src = url;
        shot.appendChild(im);

        if (r.retryCount > 0) {
          var b = document.createElement('span');
          b.className = 'album-badge';
          b.textContent = '!' + r.retryCount;
          shot.appendChild(b);
        }
        cell.appendChild(shot);

        // 路徑（過長自動換行，CSS 限 3 行）。
        //
        // ⚠️ 從【後面】往前取，不是從前面截斷。
        //    最後一層才是分辨這張要傳去哪的關鍵；前面的「防治部/02桃園/相片」
        //    每張都一樣，佔滿 3 行反而把真正有用的葉目錄擠掉。
        //    開頭補 … 表示前面還有層級，完整路徑仍可從放大檢視看到。
        var cap = document.createElement('span');
        cap.className = 'album-path';
        var full = r.targetPath || '—';
        var segs = full.split('/');
        cap.textContent = segs.length > 3 ? '…/' + segs.slice(-3).join('/') : full;
        cap.title = full;
        cell.appendChild(cap);

        // 點縮圖開放大檢視，可左右滑瀏覽整個佇列
        cell.onclick = function () { App.queue.openViewerById(r.id); };
        strip.appendChild(cell);
      });

      var cnt = $('camStripCount');
      if (cnt) { cnt.textContent = recs.length ? recs.length + ' 張待傳' : ''; }
    });
  }

  /**
   * 照片被刪掉了（或已上傳成功而移除），相簿要跟著重畫，
   * 不然會留著一張已不存在的縮圖，點下去開不起檢視器。
   */
  function notifyRemoved(id) {
    if (id && id === lastId) { lastId = null; }
    renderStrip();
  }

  /** 登出時清空相簿，換人登入不該看到前一個人的照片 */
  function stop() {
    lastId = null;
    revokeStrip();
    var strip = $('camStrip');
    if (strip) strip.innerHTML = '';
    var head = $('albumHead');
    if (head) head.style.display = 'none';
    var hint = $('camHint');
    if (hint) hint.style.display = 'block';
  }

  function init() {
    $('shutterBtn').onclick = shoot;
    $('camInput').onchange = onPicked;
    refreshShutterState();
  }

  return {
    init: init, stop: stop, refreshShutterState: refreshShutterState,
    notifyRemoved: notifyRemoved, renderStrip: renderStrip
  };
})();
