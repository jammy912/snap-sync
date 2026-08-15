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

  var flat = [];          // [{path, parent, name}]
  var selected = null;    // 目前選定的相對路徑
  var expanded = {};      // { path: true }

  function selectedPath() { return selected; }

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
    App.camera.refreshShutterState();
    try { localStorage.setItem('ss_last_target', path || ''); } catch (e) {}
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
          row.onclick = function () {
            setSelected(node.path);
            render();
            toast('已選擇：' + node.path);
          };

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
    $('refreshTreeBtn').onclick = function () { refresh(false); };
    $('pickTargetBtn').onclick = function () { App.app.switchTab('tree'); };
  }

  return {
    init: init, refresh: refresh, loadCache: loadCache,
    selectedPath: selectedPath, setSelected: setSelected, render: render
  };
})();
