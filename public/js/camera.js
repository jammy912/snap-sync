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

  function start() {
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
    }).catch(function (e) {
      toast('無法開啟相機：' + (e.message || e.name));
    });
  }

  function switchCam() {
    facingMode = (facingMode === 'environment') ? 'user' : 'environment';
    return start();
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
    if (!target) { toast('請先選擇上傳目錄'); App.app.switchTab('tree'); return; }

    var st = App.app.settings();
    var max = st.maxEdge;
    var w = v.videoWidth, h = v.videoHeight;
    if (Math.max(w, h) > max) {
      var scale = max / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    var c = $('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);

    c.toBlob(function (blob) {
      if (!blob) { toast('拍照失敗'); return; }

      var capturedAt = new Date().toISOString();   // 一律存 UTC
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
        toast('已存入佇列 (' + w + '×' + h + ', ' + App.util.fmtSize(blob.size) + ')');
        App.queue.refreshBadge();
        // 立即嘗試送出（失敗會留在佇列，由重送機制處理）
        App.queue.flush(true);
      }).catch(function (e) {
        toast('儲存失敗：' + e.message);
      });
    }, 'image/jpeg', st.quality);
  }

  function init() {
    $('startCamBtn').onclick = start;
    $('switchBtn').onclick = switchCam;
    $('shutterBtn').onclick = capture;
    window.addEventListener('beforeunload', stop);
  }

  return { init: init, start: start, stop: stop, refreshShutterState: refreshShutterState };
})();
