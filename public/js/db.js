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
    open: open, add: add, put: put, all: all, get: get, remove: remove,
    setMeta: setMeta, getMeta: getMeta
  };
})();
