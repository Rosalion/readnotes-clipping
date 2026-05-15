// content/content.js
// 内容脚本：注入到每个网页里。负责
//   - 选中文字时弹出划线工具条
//   - 创建 / 编辑 / 删除 划线与批注
//   - 把划线持久化到 chrome.storage.local（按规范化后的 URL 分组）
//   - 页面刷新后从存储里重新定位并还原划线
//   - 响应侧边栏的指令（滚动定位、删除、改批注、清除、剪藏正文）
//
// 依赖（同为内容脚本、共享作用域）：Readability、RNCAnchor、RNCHighlighter

(function () {
  "use strict";

  const NS = "rnc:";
  const SETTINGS_KEY = "rnc:settings";
  const COLORS = ["yellow", "green", "blue", "pink"];
  const COLOR_NAMES = { yellow: "蜜黄", green: "苔绿", blue: "雾蓝", pink: "陶红" };

  const state = {
    pageKey: null,
    record: null, // { url, title, highlights: [...], updatedAt }
  };
  let currentColor = "yellow";
  let lastHref = location.href;

  // ---------- URL / 存储 ----------
  function normalizeUrl(href) {
    try {
      const u = new URL(href);
      u.hash = "";
      return u.origin + u.pathname + u.search;
    } catch (e) {
      return href;
    }
  }
  function pageKeyFor(href) {
    return NS + normalizeUrl(href);
  }
  function emptyRecord() {
    return {
      url: normalizeUrl(location.href),
      title: document.title,
      highlights: [],
      updatedAt: Date.now(),
    };
  }

  async function loadRecord() {
    state.pageKey = pageKeyFor(location.href);
    try {
      const data = await chrome.storage.local.get(state.pageKey);
      state.record = data[state.pageKey] || emptyRecord();
    } catch (e) {
      state.record = emptyRecord();
    }
    return state.record;
  }

  let saveTimer = null;
  function saveRecord() {
    if (!state.record) return;
    state.record.title = document.title;
    state.record.url = normalizeUrl(location.href);
    state.record.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [state.pageKey]: state.record }).catch(() => {});
    }, 120);
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      const s = data[SETTINGS_KEY] || {};
      if (s.defaultColor && COLORS.includes(s.defaultColor)) currentColor = s.defaultColor;
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- 工具函数 ----------
  function cssId(id) {
    return window.CSS && CSS.escape ? CSS.escape(id) : String(id);
  }
  function truncate(s, n) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function isInUI(target) {
    const el = target && (target.nodeType === 1 ? target : target.parentElement);
    return !!(el && el.closest && el.closest("[data-rnc-ui]"));
  }
  function newId() {
    return "h-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  // ---------- 还原已保存的划线 ----------
  function applyAll() {
    if (!state.record || !state.record.highlights.length) return;
    for (const hl of state.record.highlights) applyOne(hl);
  }
  function applyOne(hl) {
    try {
      const range = RNCAnchor.resolveAnchor(hl.anchor, document.body);
      if (!range) {
        hl._unresolved = true;
        return;
      }
      const spans = RNCHighlighter.wrapRange(range, { id: hl.id, color: hl.color || "yellow" });
      if (hl.note) spans.forEach((s) => s.classList.add("rnc-has-note"));
      hl._unresolved = spans.length === 0;
    } catch (e) {
      hl._unresolved = true;
    }
  }

  // ---------- 选区工具条 ----------
  let toolbar = null;
  let notePopover = null;

  function buildToolbar() {
    toolbar = document.createElement("div");
    toolbar.id = "rnc-toolbar";
    toolbar.className = "rnc-ui-root";
    toolbar.setAttribute("data-rnc-ui", "");
    toolbar.style.display = "none";

    COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.className = "rnc-swatch rnc-swatch-" + c;
      b.type = "button";
      b.title = "划线（" + COLOR_NAMES[c] + "）";
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        createFromSelection(c, false);
      });
      toolbar.appendChild(b);
    });

    const sep = document.createElement("span");
    sep.className = "rnc-tb-sep";
    toolbar.appendChild(sep);

    const noteBtn = document.createElement("button");
    noteBtn.className = "rnc-tb-note";
    noteBtn.type = "button";
    noteBtn.textContent = "划线 + 批注";
    noteBtn.addEventListener("mousedown", (e) => e.preventDefault());
    noteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      createFromSelection(currentColor, true);
    });
    toolbar.appendChild(noteBtn);

    document.documentElement.appendChild(toolbar);
  }

  function showToolbar(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    toolbar.style.display = "flex";
    toolbar.style.visibility = "hidden";
    const tb = toolbar.getBoundingClientRect();
    let top = rect.top - tb.height - 8;
    if (top < 6) top = rect.bottom + 8;
    let left = rect.left + rect.width / 2 - tb.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tb.width - 6));
    toolbar.style.top = top + "px";
    toolbar.style.left = left + "px";
    toolbar.style.visibility = "visible";
  }
  function hideToolbar() {
    if (toolbar) toolbar.style.display = "none";
  }

  function createFromSelection(color, withNote) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (isInUI(range.commonAncestorContainer)) return;

    const anchor = RNCAnchor.createAnchor(range, document.body);
    if (!anchor || !anchor.exact.trim()) {
      hideToolbar();
      return;
    }

    const hl = {
      id: newId(),
      anchor,
      color,
      note: "",
      createdAt: Date.now(),
    };

    // 直接用用户选区包裹，最贴合所选内容
    const spans = RNCHighlighter.wrapRange(range, { id: hl.id, color });
    if (!spans.length) {
      hideToolbar();
      return;
    }
    // 刚划下时的轻微"落定"动画
    spans.forEach((s) => {
      s.classList.add("rnc-just-made");
      setTimeout(() => s.classList.remove("rnc-just-made"), 460);
    });
    currentColor = color;
    state.record.highlights.push(hl);
    saveRecord();

    sel.removeAllRanges();
    hideToolbar();
    if (withNote) openNoteEditor(hl, spans[0]);
  }

  // ---------- 批注编辑弹层 ----------
  function closeNotePopover() {
    if (notePopover) {
      notePopover.remove();
      notePopover = null;
    }
  }

  function openNoteEditor(hl, anchorEl) {
    closeNotePopover();
    notePopover = document.createElement("div");
    notePopover.id = "rnc-note-popover";
    notePopover.className = "rnc-ui-root";
    notePopover.setAttribute("data-rnc-ui", "");
    notePopover.innerHTML =
      '<div class="rnc-np-quote"></div>' +
      '<textarea class="rnc-np-text" rows="4" placeholder="写下你的批注…"></textarea>' +
      '<div class="rnc-np-actions">' +
      '<button type="button" class="rnc-np-del">删除划线</button>' +
      '<span class="rnc-np-spacer"></span>' +
      '<button type="button" class="rnc-np-cancel">取消</button>' +
      '<button type="button" class="rnc-np-save">保存</button>' +
      "</div>";

    notePopover.querySelector(".rnc-np-quote").textContent =
      "“" + truncate(hl.anchor.exact, 110) + "”";
    const ta = notePopover.querySelector(".rnc-np-text");
    ta.value = hl.note || "";

    document.documentElement.appendChild(notePopover);
    positionPopover(notePopover, anchorEl);
    ta.focus();

    notePopover.querySelector(".rnc-np-save").addEventListener("click", () => {
      hl.note = ta.value.trim();
      RNCHighlighter.setNoteFlag(hl.id, !!hl.note);
      saveRecord();
      closeNotePopover();
    });
    notePopover.querySelector(".rnc-np-cancel").addEventListener("click", closeNotePopover);
    notePopover.querySelector(".rnc-np-del").addEventListener("click", () => {
      deleteHighlight(hl.id);
      closeNotePopover();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeNotePopover();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        hl.note = ta.value.trim();
        RNCHighlighter.setNoteFlag(hl.id, !!hl.note);
        saveRecord();
        closeNotePopover();
      }
    });
  }

  function positionPopover(pop, anchorEl) {
    const pr = pop.getBoundingClientRect();
    let top = 80;
    let left = window.innerWidth / 2 - pr.width / 2;
    if (anchorEl && anchorEl.getBoundingClientRect) {
      const r = anchorEl.getBoundingClientRect();
      if (r.width || r.height) {
        top = r.bottom + 8;
        if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 8);
        left = r.left;
      }
    }
    left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - pr.height - 8));
    pop.style.top = top + "px";
    pop.style.left = left + "px";
  }

  // ---------- 删除 ----------
  function deleteHighlight(id) {
    RHRemove(id);
  }
  function RHRemove(id) {
    RNCHighlighter.removeHighlight(id, document.body);
    if (state.record) {
      state.record.highlights = state.record.highlights.filter((h) => h.id !== id);
      saveRecord();
    }
  }

  // ---------- 闪烁定位 ----------
  function flash(id) {
    const els = document.querySelectorAll('.rnc-highlight[data-rnc-id="' + cssId(id) + '"]');
    els.forEach((el) => {
      el.classList.remove("rnc-flash");
      void el.offsetWidth; // 重启动画
      el.classList.add("rnc-flash");
      setTimeout(() => el.classList.remove("rnc-flash"), 1400);
    });
  }

  // ---------- 剪藏正文 ----------
  function absolutizeUrls(root, base) {
    root.querySelectorAll("a[href]").forEach((a) => {
      const v = a.getAttribute("href");
      if (!v) return;
      try {
        a.setAttribute("href", new URL(v, base).href);
      } catch (e) {}
    });
    root.querySelectorAll("img[src]").forEach((img) => {
      const v = img.getAttribute("src");
      if (v) {
        try {
          img.setAttribute("src", new URL(v, base).href);
        } catch (e) {}
      }
      img.removeAttribute("srcset"); // srcset 里多是相对地址，去掉避免歧义
    });
  }

  const BLOCK_TAGS = new Set([
    "P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6",
    "PRE", "FIGURE", "FIGCAPTION", "TD", "TH", "DD", "DT",
    "SECTION", "ARTICLE", "DIV",
  ]);
  function nearestBlock(el, doc) {
    let n = el;
    while (n && n !== doc.body) {
      if (n.nodeType === 1 && BLOCK_TAGS.has(n.nodeName)) return n;
      n = n.parentNode;
    }
    return el.parentNode || doc.body;
  }

  // 在 Readability 抽取出的正文 DOM 里注入 <mark> 高亮，并在对应段落后插入批注占位块。
  function injectAnnotations(adoc) {
    const applied = new Set();
    for (const hl of state.record.highlights) {
      let range = null;
      try {
        range = RNCAnchor.resolveAnchor(hl.anchor, adoc.body);
      } catch (e) {
        range = null;
      }
      if (!range) continue;

      const marks = RNCHighlighter.wrapRange(range, {
        id: hl.id,
        color: hl.color || "yellow",
        doc: adoc,
        tagName: "mark",
        className: "rnc-mark",
      });
      if (!marks.length) continue;
      applied.add(hl.id);

      if (hl.note && hl.note.trim()) {
        // 用占位块标记批注位置，真正的批注文本由侧边栏在生成 Markdown 时填入，
        // 这样可以彻底避免 HTML 序列化对换行/特殊字符的影响。
        // textContent 必须非空：否则 Turndown 会把它当空节点直接丢弃，
        //   自定义规则就没机会执行；同时它也充当规则万一不命中时的兜底文本。
        const placeholder = adoc.createElement("blockquote");
        placeholder.setAttribute("data-rnc-note-id", hl.id);
        placeholder.textContent = hl.note.trim();
        const block = nearestBlock(marks[marks.length - 1], adoc);
        if (block && block.nodeName === "LI") {
          block.appendChild(placeholder);
        } else if (block && block.parentNode) {
          block.parentNode.insertBefore(placeholder, block.nextSibling);
        } else {
          adoc.body.appendChild(placeholder);
        }
      }
    }
    return applied;
  }

  function clipArticle() {
    const docClone = document.cloneNode(true);

    // 先把相对链接转成绝对地址（Readability 之后再补会受 baseURI 影响）
    absolutizeUrls(docClone, location.href);

    // 移除插件自身节点；把现有高亮 span 拆掉（统一以存储里的锚点为准重新注入）
    docClone.querySelectorAll("[data-rnc-ui]").forEach((n) => n.remove());
    docClone.querySelectorAll(".rnc-highlight").forEach((n) => {
      const p = n.parentNode;
      if (!p) return;
      while (n.firstChild) p.insertBefore(n.firstChild, n);
      p.removeChild(n);
    });

    if (typeof Readability === "undefined") {
      throw new Error("Readability 未加载");
    }
    const article = new Readability(docClone, { charThreshold: 200 }).parse();
    if (!article || !article.content) {
      throw new Error("无法识别这个页面的正文内容");
    }

    const adoc = new DOMParser().parseFromString(article.content, "text/html");
    const applied = injectAnnotations(adoc);

    return {
      title: article.title || document.title || "未命名文章",
      url: normalizeUrl(location.href),
      byline: article.byline || "",
      siteName: article.siteName || location.hostname,
      excerpt: article.excerpt || "",
      lang: article.lang || document.documentElement.lang || "",
      annotatedHtml: adoc.body.innerHTML,
      highlights: state.record.highlights.map((h) => ({
        id: h.id,
        color: h.color || "yellow",
        note: h.note || "",
        exact: h.anchor ? h.anchor.exact : "",
        resolved: applied.has(h.id),
        createdAt: h.createdAt || 0,
      })),
      clippedAt: new Date().toISOString(),
    };
  }

  // ---------- 与侧边栏通信 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false, error: "bad message" });
      return false;
    }
    (async () => {
      try {
        switch (msg.type) {
          case "rnc-ping":
            sendResponse({
              ok: true,
              url: normalizeUrl(location.href),
              title: document.title,
              count: state.record ? state.record.highlights.length : 0,
            });
            break;

          case "rnc-scroll-to": {
            const el = document.querySelector(
              '.rnc-highlight[data-rnc-id="' + cssId(msg.id) + '"]'
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              flash(msg.id);
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: "该划线在当前页面未能定位（可能页面已变化）" });
            }
            break;
          }

          case "rnc-delete":
            RHRemove(msg.id);
            sendResponse({ ok: true });
            break;

          case "rnc-update-note": {
            const hl = state.record.highlights.find((h) => h.id === msg.id);
            if (hl) {
              hl.note = (msg.note || "").trim();
              RNCHighlighter.setNoteFlag(hl.id, !!hl.note);
              saveRecord();
            }
            sendResponse({ ok: true });
            break;
          }

          case "rnc-edit-note": {
            const el = document.querySelector(
              '.rnc-highlight[data-rnc-id="' + cssId(msg.id) + '"]'
            );
            const hl = state.record.highlights.find((h) => h.id === msg.id);
            if (hl) {
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
              openNoteEditor(hl, el || document.body);
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: "未找到该划线" });
            }
            break;
          }

          case "rnc-clear": {
            await chrome.storage.local.remove(state.pageKey);
            state.record = emptyRecord();
            if (msg.reload) {
              RNCHighlighter.clearAll(document.body);
              sendResponse({ ok: true });
              location.reload();
            } else {
              // 不强制刷新：保留页面上已渲染的划线，直到用户手动刷新
              sendResponse({ ok: true });
            }
            break;
          }

          case "rnc-clip": {
            try {
              sendResponse({ ok: true, clip: clipArticle() });
            } catch (e) {
              sendResponse({ ok: false, error: String((e && e.message) || e) });
            }
            break;
          }

          default:
            sendResponse({ ok: false, error: "unknown message: " + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  });

  // ---------- 全局事件 ----------
  function bindEvents() {
    document.addEventListener("mouseup", (e) => {
      if (isInUI(e.target)) return;
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
          hideToolbar();
          return;
        }
        const range = sel.getRangeAt(0);
        if (isInUI(range.commonAncestorContainer)) {
          hideToolbar();
          return;
        }
        showToolbar(range);
      }, 10);
    });

    document.addEventListener("selectionchange", () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) hideToolbar();
    });

    document.addEventListener("scroll", hideToolbar, true);
    window.addEventListener("resize", hideToolbar);

    document.addEventListener("click", (e) => {
      // 点已有高亮 -> 打开批注编辑
      if (!isInUI(e.target)) {
        const hlEl = e.target.closest && e.target.closest(".rnc-highlight");
        if (hlEl) {
          const id = hlEl.getAttribute("data-rnc-id");
          const hl = state.record && state.record.highlights.find((h) => h.id === id);
          if (hl) {
            e.preventDefault();
            openNoteEditor(hl, hlEl);
            return;
          }
        }
      }
      // 点弹层之外 -> 关闭批注弹层
      if (notePopover && !isInUI(e.target)) closeNotePopover();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideToolbar();
    });

    // SPA / 单页应用的地址变化
    window.addEventListener("popstate", checkUrlChange);
    window.addEventListener("hashchange", checkUrlChange);
    setInterval(checkUrlChange, 1200);
  }

  async function checkUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const newKey = pageKeyFor(location.href);
    if (newKey === state.pageKey) return; // 仅 hash 变化，正文未变
    closeNotePopover();
    hideToolbar();
    await loadRecord();
    // 等 SPA 把新内容渲染出来再还原划线
    setTimeout(applyAll, 600);
  }

  // ---------- 启动 ----------
  async function init() {
    if (window.__rncContentLoaded) return;
    window.__rncContentLoaded = true;
    buildToolbar();
    await loadSettings();
    await loadRecord();
    applyAll();
    bindEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
