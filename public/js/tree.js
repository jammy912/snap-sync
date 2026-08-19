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
  var counts = {};        // { path: 待上傳張數 }，含下層加總

  function selectedPath() { return selected; }

  /* ---------- 待上傳張數 ---------- */

  /**
   * 從佇列統計每個目錄的待上傳張數。
   *
   * 張數會【往上層累加】：拍在「專案A/3F/牆面」的照片，
   * 在收合狀態下的「專案A」也要看得到，否則收起來就等於看不見。
   * render() 是同步的（被多處呼叫），所以這裡先算好存進 counts 快取。
   */
  function refreshCounts() {
    return App.db.all().then(function (recs) {
      var map = {};
      recs.forEach(function (r) {
        var p = r.targetPath;
        if (!p) return;
        var parts = String(p).split('/');
        var acc = '';
        for (var i = 0; i < parts.length; i++) {
          acc = acc ? acc + '/' + parts[i] : parts[i];
          map[acc] = (map[acc] || 0) + 1;
        }
      });
      counts = map;
    }).catch(function () { /* 統計失敗不該讓目錄樹開不起來 */ });
  }

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
    // 只留仍存在、且仍是葉節點的（目錄可能被刪、改名，或新增了子目錄
    // 而變成分枝——分枝不能當上傳目標，留著只會讓人點了被擋回來）
    var exists = {};
    for (var i = 0; i < flat.length; i++) exists[flat[i].path] = true;
    var byParent = buildIndex(flat);
    var list = recentList().filter(function (p) {
      return exists[p] && !(byParent[p] && byParent[p].length);
    });

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
      // ⚠️ 包一層 <bdi dir="ltr">。CSS 把這一格設成 rtl 才能讓省略號
      //    出現在【前面】（保留末層目錄），但那會讓路徑裡的 "/" 被
      //    BiDi 演算法重排。bdi 把內容隔離回 ltr，顯示順序才正確。
      //    用 textContent 塞進 bdi，不用 innerHTML 拼字串——
      //    目錄名稱來自伺服器，直接拼會有 XSS 風險。
      label.textContent = '';
      var bdi = document.createElement('bdi');
      bdi.setAttribute('dir', 'ltr');
      bdi.textContent = path;
      label.appendChild(bdi);
      label.title = path;
      label.classList.remove('unset');
    } else {
      label.textContent = '尚未選擇目錄';
      label.removeAttribute('title');
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
    // 再擋一次非葉節點。這是共用入口——「最近」的捷徑也走這裡，
    // 而目錄樹更新後，原本的葉節點可能多出子目錄而變成分枝。
    // 此時不選取，改為展開讓使用者往下挑到實際的末層目錄。
    var byParent = buildIndex(flat);
    if (byParent[path] && byParent[path].length) {
      expandTo(path);
      expanded[path] = true;
      if (!isSheetOpen()) { openSheet(); } else { render(); }
      toast('「' + path.split('/').pop() + '」底下還有子目錄，請選到最末層');
      return;
    }

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
    // 先用既有快取畫出來（浮層要立刻有東西），張數算完再重畫一次
    render();
    renderRecent();
    refreshCounts().then(function () {
      if (isSheetOpen()) render();
    });
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

          // 有待上傳照片才顯示，沒有就完全不佔位置
          var n = counts[node.path] || 0;
          if (n > 0) {
            var cnt = document.createElement('span');
            cnt.className = 'tree-count';
            cnt.textContent = '(' + n + ')';
            cnt.title = n + ' 張待上傳（含子目錄）';
            row.appendChild(cnt);
          }

          // 【只有葉節點可選】有子目錄的節點點了是展開／收合，不能當上傳目標。
          //
          // 照片一律要落在最末層的實際目錄。選到中間層會讓照片散在
          // 「115年」這種分類目錄下，而不是「115年/8月/B1」——事後很難整理，
          // 現場也不會發現自己選錯了層級。
          if (hasKids) {
            row.classList.add('branch');
            row.onclick = function () {
              expanded[node.path] = !expanded[node.path];
              render();
            };
          } else {
            row.onclick = function () { choose(node.path); };
          }

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
    // 目錄樹更新後，原本的葉節點可能多出子目錄而變成分枝。
    // 這種情況要取消選取——否則快門仍是啟用的，照片會落在中間分類層
    // （例如落在「115年」而不是「115年/8月/B1」），事後很難整理。
    var byParent = buildIndex(flat);
    var becameBranch = stillExists && byParent[last] && byParent[last].length;

    if (stillExists && !becameBranch) { expandTo(last); setSelected(last); }
    else if (becameBranch) {
      setSelected(null);
      expandTo(last);
      expanded[last] = true;
      toast('「' + last.split('/').pop() + '」新增了子目錄，請重新選到最末層');
    }
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
    $('pickDirBtn').onclick = openSheet;      // 相機控制列最左邊的資料夾鍵
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
    openSheet: openSheet, closeSheet: closeSheet, renderRecent: renderRecent,
    refreshCounts: refreshCounts, isSheetOpen: isSheetOpen
  };
})();
