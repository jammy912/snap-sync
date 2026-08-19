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
          showLastShot(blob, id);
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

  /**
   * 顯示剛拍好的那張。
   * 沒有即時預覽之後，這塊空著會讓人以為相機壞了；擺上最後一張
   * 至少能確認「剛剛那張拍進去了、拍成什麼樣」。
   * 點下去會開放大檢視（可左右滑、放大、刪除），拍糊了當場就能重拍。
   */
  var lastUrl = null;
  var lastId = null;
  function showLastShot(blob, id) {
    var img = $('lastShot');
    if (!img) return;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    lastId = id;
    img.src = lastUrl;
    img.style.display = 'block';
    var hint = $('camHint');
    if (hint) hint.style.display = 'none';
    var tip = $('camReviewTip');
    if (tip) tip.style.display = 'block';
  }

  /**
   * 那張預覽的照片被刪掉了（在放大檢視裡刪的），把預覽收掉。
   * 不處理的話畫面還留著一張已經不存在的照片，點下去會開不起來。
   */
  function notifyRemoved(id) {
    if (id && id === lastId) { stop(); }
  }

  /** 登出時清掉畫面上的最後一張，換人登入不該看到前一個人的照片 */
  function stop() {
    var img = $('lastShot');
    if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
    lastId = null;
    var hint = $('camHint');
    if (hint) hint.style.display = '';
    var tip = $('camReviewTip');
    if (tip) tip.style.display = 'none';
  }

  function init() {
    $('shutterBtn').onclick = shoot;
    $('camInput').onchange = onPicked;

    // 點預覽開放大檢視。檢視器是佇列頁那一套（左右滑換張、點圖放大、
    // 刪除），不另外做一份——重複實作遲早會有一邊漏修。
    var last = $('lastShot');
    if (last) {
      last.onclick = function () {
        if (!lastId) return;
        App.queue.openViewerById(lastId);
      };
    }

    refreshShutterState();
  }

  return {
    init: init, stop: stop, refreshShutterState: refreshShutterState,
    notifyRemoved: notifyRemoved
  };
})();
