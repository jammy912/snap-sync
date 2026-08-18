/* camera.js — 相機與拍照壓縮
 * 縮圖邏輯沿用 sample CAP/index.html 的 capture()，預設值改為規劃書的
 * 長邊 1600px / JPEG 品質 0.7。
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

  var stream = null;
  var facingMode = 'environment';

  // 這一輪要不要在照片上燒入時間浮水印。
  // 刻意【不記憶】：每次開相機拿到授權後都重新詢問，由使用者當下決定。
  // 同一支手機可能今天拍驗收（要時間佐證）、明天拍現況參考（不要），
  // 記住上次的選擇反而會讓人忘記檢查。
  var watermark = false;

  function start(skipAsk) {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      stream = s;
      var v = $('video');
      v.srcObject = s;
      v.style.display = 'block';
      $('camPlaceholder').style.display = 'none';
      $('startCamBtn').style.display = 'none';
      $('switchBtn').style.display = 'flex';
      refreshShutterState();
      // 切換鏡頭時不重複詢問——那是同一輪拍攝，使用者已經決定過了
      if (!skipAsk) { askWatermark(); }
    }).catch(function (e) {
      toast('無法開啟相機：' + (e.message || e.name));
    });
  }

  /**
   * 取得相機授權後詢問這一輪要不要加浮水印。
   *
   * 用自訂浮層而非 confirm()：原生對話框在 PWA 上樣式突兀，
   * 而且會阻塞事件迴圈（相機串流剛啟動時可能造成畫面卡住）。
   */
  function askWatermark() {
    var box = $('wmAsk');
    if (!box) { watermark = false; return; }
    // 預覽用當下時間，讓使用者看到實際會燒上去的格式
    var pv = $('wmPreview');
    if (pv) {
      var d = new Date();
      var p = function (n) { return n < 10 ? '0' + n : '' + n; };
      pv.textContent = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                       '  ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    box.style.display = 'flex';
  }

  function closeWatermarkAsk(yes) {
    watermark = !!yes;
    var box = $('wmAsk');
    if (box) box.style.display = 'none';
    toast(yes ? '本次拍照會加上時間浮水印' : '本次拍照不加浮水印');
  }

  /**
   * 在照片左下角燒入日期與時間。
   *
   * ⚠️ 這是【不可逆】的：直接畫進 JPEG，事後無法移除。
   * 工程驗收照片需要時間佐證，這正是要的效果；但也因此每次開相機都要問，
   * 不能預設幫使用者決定。
   *
   * 字級依照片尺寸換算（長邊的 3.6%），縮圖或放大時比例才一致；
   * 深色半透明底條確保在淺色地面、強光牆面上都讀得到。
   */
  function drawWatermark(ctx, w, h, iso) {
    var d = new Date(iso);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var line = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
               '  ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());

    var fs = Math.round(Math.max(w, h) * 0.036);
    var pad = Math.round(fs * 0.5);
    ctx.font = '600 ' + fs + 'px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif';
    ctx.textBaseline = 'alphabetic';

    var tw = ctx.measureText(line).width;
    var barH = fs + pad * 2;
    var x = pad;
    var y = h - pad;

    // 半透明底條：純文字在淺色地面上會看不見
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, h - barH, tw + pad * 2, barH);

    // 再加一層描邊，底條若被亮處穿透仍讀得到
    ctx.lineWidth = Math.max(2, fs * 0.09);
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    ctx.strokeText(line, x, y - pad * 0.4);
    ctx.fillStyle = '#fff';
    ctx.fillText(line, x, y - pad * 0.4);
  }

  function switchCam() {
    facingMode = (facingMode === 'environment') ? 'user' : 'environment';
    return start(true);
  }

  function stop() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  /** 未開相機或未選目錄時，快門停用 */
  function refreshShutterState() {
    var ready = !!stream && !!App.tree.selectedPath();
    $('shutterBtn').disabled = !ready;
  }

  function capture() {
    var v = $('video');
    if (!v.videoWidth) { toast('相機尚未就緒'); return; }

    var target = App.tree.selectedPath();
    if (!target) { toast('請先選擇上傳目錄'); App.tree.openSheet(); return; }

    var st = App.app.settings();
    var max = st.maxEdge;
    var w = v.videoWidth, h = v.videoHeight;
    if (Math.max(w, h) > max) {
      var scale = max / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    // ⚠️ 時間要在畫浮水印之前取得，且與記錄共用同一個值。
    //    若等到 toBlob 的回呼裡才取，浮水印上的時間會與 capturedAt、
    //    檔名的時間戳不一致（差幾百毫秒，跨秒時就對不起來了）。
    var capturedAt = new Date().toISOString();   // 一律存 UTC

    var c = $('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);
    if (watermark) { drawWatermark(ctx, w, h, capturedAt); }

    c.toBlob(function (blob) {
      if (!blob) { toast('拍照失敗'); return; }
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
        // 只講最後一層目錄與大小，維持單行。
        // 完整路徑已常駐在上方的「上傳至」列，這裡重複只會把 toast 撐成兩行，
        // 在相機畫面上佔掉更多視野。
        var parts = target.split('/');
        toast('已存至 ' + parts[parts.length - 1] + ' · ' + App.util.fmtSize(blob.size));
        // 【不自動上傳】拍完只入佇列，等使用者確認完按「傳送」才送。
        // 原本拍一張就送一張，會在連拍時邊拍邊佔網路，
        // 也讓「拍錯想刪掉重拍」變得來不及——照片早就上雲端了。
        App.queue.refreshBadge();
      }).catch(function (e) {
        toast('儲存失敗：' + e.message);
      });
    }, 'image/jpeg', st.quality);
  }

  function init() {
    // ⚠️ 不可寫成 onclick = start：事件物件會被當成 skipAsk（truthy），
    //    導致按鈕開相機時不詢問浮水印。
    $('startCamBtn').onclick = function () { start(); };
    $('switchBtn').onclick = switchCam;
    $('shutterBtn').onclick = capture;

    // 元素可能不存在（SW 快取到舊版 HTML），判空避免中斷整個 init
    var yes = $('wmYesBtn'), no = $('wmNoBtn');
    if (yes) yes.onclick = function () { closeWatermarkAsk(true); };
    if (no) no.onclick = function () { closeWatermarkAsk(false); };

    window.addEventListener('beforeunload', stop);
  }

  return { init: init, start: start, stop: stop, refreshShutterState: refreshShutterState };
})();
