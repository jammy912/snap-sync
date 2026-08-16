/* tree.js — 目錄樹取得、快取與渲染
 *
 * 伺服器回傳的是扁平清單 {path, parent, name}（已限縮於該使用者子樹），
 * 這裡用 parent 欄位組回樹狀。不採「整棵樹存單一儲存格」是因為 Sheet
 * 單格上限 50,000 字元，目錄一大就會被截斷。
 *
 * 取得後快取進 IndexedDB，離線時仍可展開選目錄。
 */
'use strict';

var App = window.App || {};
window.App = App;

App.tree = (function () {
  var $ = App.util.$;
  var toast = App.util.toast;
  var META_KEY = 'tree_cache';
  var RECENT_KEY = 'ss_recent_targets';
  var RECENT_MAX = 5;

  var flat = [];          // [{path, parent, name}]
  var selected = null;    // 目前選定的相對路徑
  var expanded = {};      // { path: true }

  function selectedPath() { return selected; }

  /* ---------- 最近使用的目錄 ---------- */

  function recentList() {
    try {
      var v = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function pushRecent(path) {
    if (!path) return;
    var list = recentList().filter(function (p) { return p !== path; });
    list.unshift(path);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) {}
  }

  function renderRecent() {
    var bar = $('recentBar');
    var box = $('recentChips');
    // 只留仍存在於目前樹中的（目錄可能被刪或改名）
    var exists = {};
    for (var i = 0; i < flat.length; i++) exists[flat[i].path] = true;
    var list = recentList().filter(function (p) { return exists[p]; });

    box.innerHTML = '';
    if (!list.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';

    list.forEach(function (p) {
      var chip = document.createElement('button');
      chip.className = 'recent-chip' + (p === selected ? ' active' : '');
      // 只顯示最後一層，路徑深時才看得清楚；完整路徑放 title
      chip.textContent = p.split('/').pop();
      chip.title = p;
      chip.onclick = function () { choose(p); };
      box.appendChild(chip);
    });
  }

  function setSelected(path) {
    selected = path;
    var label = $('targetLabel');
    if (path) {
      label.textContent = path;
      label.classList.remove('unset');
    } else {
      label.textContent = '尚未選擇目錄';
      label.classList.add('unset');
    }
    // 未選目錄時在相機上蓋一層引導（比只停用快門明確）
    var guide = $('needTarget');
    if (guide) guide.style.display = path ? 'none' : 'flex';

    App.camera.refreshShutterState();
    try { localStorage.setItem('ss_last_target', path || ''); } catch (e) {}
  }

  /** 選定目錄：記入最近使用、關閉浮層回到相機 */
  function choose(path) {
    setSelected(path);
    pushRecent(path);
    expandTo(path);
    render();
    closeSheet();
    toast('已選擇：' + path);
  }

  /* ---------- 浮層開關 ---------- */

  function openSheet() {
    $('treeSheet').style.display = 'flex';
    expandTo(selected);
    render();
    renderRecent();
  }

  function closeSheet() {
    $('treeSheet').style.display = 'none';
  }

  function isSheetOpen() {
    return $('treeSheet').style.display !== 'none';
  }

  /** 由扁平清單組出 { parentPath: [children] } */
  function buildIndex(items) {
    var byParent = {};
    for (var i = 0; i < items.length; i++) {
      var p = items[i].parent || '';
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(items[i]);
    }
    Object.keys(byParent).forEach(function (k) {
      byParent[k].sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hant'); });
    });
    return byParent;
  }

  function render() {
    var root = $('treeRoot');
    root.innerHTML = '';

    if (!flat.length) {
      $('treeEmpty').style.display = 'block';
      $('treeInfo').textContent = '0 個目錄';
      return;
    }
    $('treeEmpty').style.display = 'none';
    $('treeInfo').textContent = flat.length + ' 個目錄';

    var byParent = buildIndex(flat);

    function renderLevel(parentPath, container) {
      var children = byParent[parentPath] || [];
      for (var i = 0; i < children.length; i++) {
        (function (node) {
          var hasKids = !!(byParent[node.path] && byParent[node.path].length);
          var isOpen = !!expanded[node.path];

          var wrap = document.createElement('div');
          wrap.className = 'tree-node';

          var row = document.createElement('div');
          row.className = 'tree-row' + (selected === node.path ? ' selected' : '');

          var toggle = document.createElement('span');
          toggle.className = 'tree-toggle' + (hasKids ? '' : ' leaf');
          toggle.textContent = hasKids ? (isOpen ? '▼' : '▶') : '•';
          toggle.onclick = function (e) {
            e.stopPropagation();
            if (!hasKids) return;
            expanded[node.path] = !expanded[node.path];
            render();
          };

          var name = document.createElement('span');
          name.className = 'tree-name';
          name.textContent = node.name;

          row.appendChild(toggle);
          row.appendChild(name);
          row.onclick = function () { choose(node.path); };

          wrap.appendChild(row);

          if (hasKids && isOpen) {
            var kids = document.createElement('div');
            kids.className = 'tree-children';
            renderLevel(node.path, kids);
            wrap.appendChild(kids);
          }
          container.appendChild(wrap);
        })(children[i]);
      }
    }

    renderLevel('', root);
  }

  /** 展開通往某路徑的所有上層節點 */
  function expandTo(path) {
    if (!path) return;
    var parts = path.split('/');
    var acc = '';
    for (var i = 0; i < parts.length - 1; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      expanded[acc] = true;
    }
  }

  function applyData(items) {
    flat = items || [];

    // 還原上次選的目錄（若仍存在於樹中）
    var last = '';
    try { last = localStorage.getItem('ss_last_target') || ''; } catch (e) {}
    var stillExists = false;
    for (var i = 0; i < flat.length; i++) {
      if (flat[i].path === last) { stillExists = true; break; }
    }
    if (stillExists) { expandTo(last); setSelected(last); }
    else if (selected) {
      // 原本選的目錄已消失（目錄被刪或改名）
      setSelected(null);
    }
    render();
    renderRecent();
  }

  /** 從伺服器抓最新目錄樹；失敗則沿用快取 */
  function refresh(silent) {
    var token = App.auth.token();
    if (!token) return Promise.resolve();

    return App.api.tree(token).then(function (data) {
      applyData(data.tree);
      return App.db.setMeta(META_KEY, { tree: data.tree, at: Date.now() });
    }).then(function () {
      if (!silent) toast('目錄已更新');
    }).catch(function (err) {
      if (App.auth.isAuthError(err)) {
        App.auth.forceLogout(err.message);
        return;
      }
      if (!silent) toast('取得目錄失敗：' + err.message);
    });
  }

  /** 啟動時先用快取渲染，讓離線也能選目錄 */
  function loadCache() {
    return App.db.getMeta(META_KEY).then(function (cached) {
      if (cached && cached.tree && cached.tree.length) applyData(cached.tree);
      return cached;
    });
  }

  function init() {
    $('refreshTreeBtn').onclick = function () {
      refresh(false).then(renderRecent);
    };
    $('targetBar').onclick = openSheet;
    $('needTarget').onclick = openSheet;
    $('closeSheetBtn').onclick = closeSheet;

    // 點浮層外的暗色區域關閉；點面板內不關
    $('treeSheet').onclick = function (e) {
      if (e.target === $('treeSheet')) closeSheet();
    };
    $('treeSheetPanel').onclick = function (e) { e.stopPropagation(); };

    // Android 實體返回鍵／瀏覽器上一頁優先關浮層，不要直接離開 App
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isSheetOpen()) closeSheet();
    });
  }

  return {
    init: init, refresh: refresh, loadCache: loadCache,
    selectedPath: selectedPath, setSelected: setSelected, render: render,
    openSheet: openSheet, closeSheet: closeSheet, renderRecent: renderRecent
  };
})();
