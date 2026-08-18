/* db.js — IndexedDB 封裝（沿用 sample CAP/index.html 的實作，擴充 schema）
 *
 * v2 schema：
 *   photos   照片佇列（keyPath: id，即前端產生的 uuid）
 *   meta     雜項（目錄樹快取等，keyPath: key）
 */
'use strict';

var App = window.App || {};
window.App = App;

App.db = (function () {
  var DB_NAME = 'snapsync_db';
  var DB_VERSION = 2;
  var STORE_PHOTOS = 'photos';
  var STORE_META = 'meta';
  var db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_PHOTOS)) {
          d.createObjectStore(STORE_PHOTOS, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(STORE_META)) {
          d.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function tx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function add(rec) {
    return new Promise(function (res, rej) {
      var t = db.transaction(STORE_PHOTOS, 'readwrite');
      t.objectStore(STORE_PHOTOS).add(rec);
      t.oncomplete = function () { res(); };
      t.onerror = function (e) { rej(e.target.error); };
    });
  }

  function put(rec) {
    return new Promise(function (res, rej) {
      var t = db.transaction(STORE_PHOTOS, 'readwrite');
      t.objectStore(STORE_PHOTOS).put(rec);
      t.oncomplete = function () { res(); };
      t.onerror = function (e) { rej(e.target.error); };
    });
  }

  function all() {
    return new Promise(function (res, rej) {
      var req = tx(STORE_PHOTOS, 'readonly').getAll();
      req.onsuccess = function () { res(req.result || []); };
      req.onerror = function (e) { rej(e.target.error); };
    });
  }

  function get(id) {
    return new Promise(function (res, rej) {
      var req = tx(STORE_PHOTOS, 'readonly').get(id);
      req.onsuccess = function () { res(req.result); };
      req.onerror = function (e) { rej(e.target.error); };
    });
  }

  /**
   * 只更新重試狀態，【不碰 blob】。
   *
   * ⚠️ 不可用 put(rec) 寫回上傳失敗的那筆記錄。
   * rec 是 getAll() 取出的複本，其 blob 經 FileReader 讀過之後再 put 回去，
   * iOS Safari 會存進一個已失效的 blob 參照——之後 createObjectURL 產生的
   * 網址讀不到內容，縮圖就變成破圖（實測：只有上傳失敗過的那張會破）。
   *
   * 這裡改成在同一個 transaction 內重讀原始記錄、只覆寫欄位再寫回，
   * 原本存在 IndexedDB 裡的 blob 完全不動。
   */
  function patch(id, fields) {
    return new Promise(function (res, rej) {
      var t = db.transaction(STORE_PHOTOS, 'readwrite');
      var store = t.objectStore(STORE_PHOTOS);
      var req = store.get(id);
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) { res(false); return; }        // 已被刪除，不重建

        // ⚠️ 用 cursor 更新，不可用 store.put(cur)。
        //
        // put(cur) 會把【整筆記錄】重寫一次，包含 blob。iOS Safari 對
        // 「讀出來再寫回去」的 blob 會產生一個暫時失效的參照——緊接著
        // 用它上傳就會拋「Error preparing Blob/File data...」，但下一輪
        // 重讀又是好的。症狀是【第一次傳送必失敗、重試後正常】：
        // 按下傳送時 prepare 會逐筆 patch(confirmed:true)，blob 就在
        // 這一刻被寫壞，然後立刻拿去上傳。
        //
        // 兩道防護：
        // 1. 值沒變就完全不寫，blob 不受影響
        var changed = false;
        Object.keys(fields).forEach(function (k) {
          if (cur[k] !== fields[k]) { cur[k] = fields[k]; changed = true; }
        });
        if (!changed) { res(true); return; }

        // 2. 真的要寫時，用同型別重新包一個 Blob 再寫回。
        //    重新建構會切斷「讀出來的那個參照」，寫進去的是一份乾淨的資料，
        //    後續讀取就不會拿到失效參照。成本是一次記憶體複製，
        //    但照片已壓縮過（數百 KB），代價遠低於整批傳送失敗。
        if (cur.blob instanceof Blob) {
          try {
            cur.blob = new Blob([cur.blob], { type: cur.blob.type || 'image/jpeg' });
          } catch (e) { /* 重建失敗就用原本的，至少不比現在差 */ }
        }

        store.put(cur);
      };
      t.oncomplete = function () { res(true); };
      t.onerror = function (e) { rej(e.target.error); };
    });
  }

  function remove(id) {
    return new Promise(function (res, rej) {
      var t = db.transaction(STORE_PHOTOS, 'readwrite');
      t.objectStore(STORE_PHOTOS).delete(id);
      t.oncomplete = function () { res(); };
      t.onerror = function (e) { rej(e.target.error); };
    });
  }

  function setMeta(key, value) {
    return new Promise(function (res, rej) {
      var t = db.transaction(STORE_META, 'readwrite');
      t.objectStore(STORE_META).put({ key: key, value: value });
      t.oncomplete = function () { res(); };
      t.onerror = function (e) { rej(e.target.error); };
    });
  }

  function getMeta(key) {
    return new Promise(function (res, rej) {
      var req = tx(STORE_META, 'readonly').get(key);
      req.onsuccess = function () { res(req.result ? req.result.value : null); };
      req.onerror = function (e) { rej(e.target.error); };
    });
  }

  return {
    open: open, add: add, put: put, patch: patch, all: all, get: get, remove: remove,
    setMeta: setMeta, getMeta: getMeta
  };
})();
