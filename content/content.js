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
  let pollTimer = null;
  let cleanedUp = false;

  // 探测扩展运行时是否还活着。当扩展被 reload / 更新 / 卸载后，旧的 content script
  // 还会留在已打开的页面里运行；这时 chrome.runtime.id 变 undefined（或访问抛错），
  // 任何 chrome.* 调用都会同步抛 "Extension context invalidated"。
  function isExtensionAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // 一旦判定 context 已死，把所有还在跑的定时器、还挂着的 UI 节点统一拆掉，
  // 让这份"老脚本"安静地退场，不再持续吐 Uncaught。
  function cleanupOnInvalidated() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { clearTimeout(saveTimer); } catch (e) {}
    try { clearInterval(pollTimer); } catch (e) {}
    saveTimer = null;
    pollTimer = null;
    try { if (toolbar) toolbar.remove(); } catch (e) {}
    try { if (notePopover) notePopover.remove(); } catch (e) {}
    toolbar = null;
    notePopover = null;
  }

  function saveRecord() {
    if (!state.record) return;
    if (!isExtensionAlive()) { cleanupOnInvalidated(); return; }
    state.record.title = document.title;
    state.record.url = normalizeUrl(location.href);
    state.record.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!isExtensionAlive()) { cleanupOnInvalidated(); return; }
      try {
        // 保留侧边栏写入的 exportFilePath（避免旧内存覆盖）
        const data = await chrome.storage.local.get(state.pageKey);
        const existing = data[state.pageKey];
        if (existing && existing.exportFilePath) {
          state.record.exportFilePath = existing.exportFilePath;
        }
        const p = chrome.storage.local.set({ [state.pageKey]: state.record });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (e) {
        cleanupOnInvalidated();
      }
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
    if (!toolbar) return; // cleanup 后 toolbar 已被 remove
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

  // 懒加载图片真正的源可能藏在这些属性里（按优先级）
  const LAZY_SRC_ATTRS = [
    "data-src",
    "data-original",
    "data-actualsrc",
    "data-actual-src",
    "data-lazy-src",
    "data-lazy",
    "data-fallback-src",
    "data-hi-res-src",
    "data-image",
  ];
  const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

  // 一眼看上去就不该出现在最终文档里的 src（占位、空、内联 SVG 1×1 等）
  function isPlaceholderSrc(v) {
    if (!v) return true;
    const s = String(v).trim();
    if (!s) return true;
    if (/^data:/i.test(s)) return true; // 占位用 data URI（含 1×1 SVG）
    if (/about:blank/i.test(s)) return true;
    if (
      /(^|[/?_=-])(blank|spacer|placeholder|loader|loading|grey|gray|1x1|pixel|transparent)\.(gif|png|svg|webp)\b/i.test(
        s
      )
    )
      return true;
    return false;
  }

  // 从 srcset 字符串里挑分辨率最大的那张。
  // 难点：srcset 条目之间用逗号分隔，但 URL 自己也可能含逗号
  // （典型的就是 Substack 的 fetch 参数段 $s_!xxx!,w_1456,c_limit,...），
  // 用单纯的 .split(",") 会把 URL 拦腰切断 → 拼出错误的相对路径。
  // 这里把分隔符限定为"逗号 + 空白 + 紧跟一个 URL 开头"才算条目边界。
  function pickFromSrcset(ss) {
    if (!ss) return "";
    const items = String(ss)
      .split(/,\s+(?=https?:\/\/|\/\/|\/|data:)/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // 条目格式 "<url><空白><数字><w|x>"；descriptor 可缺省
        const m = s.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/);
        if (!m) return null;
        return { url: m[1], score: m[2] ? parseFloat(m[2]) : 0 };
      })
      .filter((it) => it && it.url && !isPlaceholderSrc(it.url));
    if (!items.length) return "";
    items.sort((a, b) => b.score - a.score);
    return items[0].url;
  }

  // 把常见 "图片代理 CDN" 包装解开，还原成原始可被 Notion 抓取的直链。
  // 例：
  //   https://substackcdn.com/image/fetch/$s_!xxx!,w_1456,c_limit,f_auto,.../https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2F...png
  //   → https://substack-post-media.s3.amazonaws.com/...png
  function unwrapCdnProxy(u) {
    if (!u) return u;
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      const path = url.pathname;

      // Substack 的图片代理：/image/fetch/<参数段，无斜杠>/<URL-encoded 原图>
      if (
        (host === "substackcdn.com" || host.endsWith(".substackcdn.com")) &&
        path.startsWith("/image/fetch/")
      ) {
        const m = path.match(/^\/image\/fetch\/[^/]+\/(.+)$/);
        if (m) {
          let inner = m[1];
          // Substack 一般编码一次；偶有两层编码的页面，递归解一下兜底
          for (let i = 0; i < 3 && /%[0-9a-fA-F]{2}/.test(inner); i++) {
            inner = decodeURIComponent(inner);
            if (/^https?:\/\//i.test(inner)) break;
          }
          if (/^https?:\/\//i.test(inner)) return inner + (url.search || "");
        }
      }

      // images.weserv.nl / wsrv.nl 透明代理：?url=<encoded>
      if (
        host === "images.weserv.nl" ||
        host === "wsrv.nl" ||
        host === "imageproxy.pimg.tw"
      ) {
        const pass =
          url.searchParams.get("url") ||
          url.searchParams.get("src") ||
          url.searchParams.get("u");
        if (pass) {
          const real = /^https?:\/\//i.test(pass) ? pass : "https://" + pass;
          return real;
        }
      }
    } catch (e) {}
    return u;
  }

  // 选出这张 <img> 当下"最像真图"的那个 URL。
  // 优先级：
  //   1. data-src / data-original 等 ——「这才是真图」的强信号（懒加载）
  //   2. src ——若已经是完整 URL，直接用（避开 srcset 解析歧义）
  //   3. srcset / data-srcset —— 只在前两者都无效时兜底
  // 之前把 srcset 排在 src 前面，导致 Substack 这种 src 干净、srcset 内含逗号
  // 的页面被 srcset 解析错误污染。
  function resolveImgUrl(img) {
    for (const attr of LAZY_SRC_ATTRS) {
      const v = img.getAttribute(attr);
      if (v && !isPlaceholderSrc(v)) return v;
    }
    const src = img.getAttribute("src");
    if (src && !isPlaceholderSrc(src)) return src;
    for (const attr of LAZY_SRCSET_ATTRS) {
      const picked = pickFromSrcset(img.getAttribute(attr));
      if (picked) return picked;
    }
    const picked = pickFromSrcset(img.getAttribute("srcset"));
    if (picked) return picked;
    return "";
  }

  // 让 heading 顺利穿过 Readability。
  //
  // Readability 的 unlikelyCandidates 正则会把 class 名里含 "header" / "banner" /
  // "footer" / "sidebar" 的元素直接当非正文删掉 —— 本来是用来杀页眉、侧栏的，
  // 但 Substack 的章节标题 class 就叫 "header-anchor-post"（"header" 命中），
  // 整个 <h2> 节点连同文字会被剥掉，Notion 里章节标题彻底消失。
  // 同类问题在很多平台的"复制锚点链接"按钮 class 上都可能撞到，所以这里
  // 对所有 heading 一律：① 清掉 class（heading 本身就是 semantic 标签，
  // 不需要靠 class 识别），② 移除嵌进 heading 的装饰性 div/按钮/svg。
  function sanitizeHeadings(root) {
    root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      // ① 清除 class / id，避开 Readability unlikelyCandidates 启发式的误伤
      h.removeAttribute("class");
      h.removeAttribute("id");
      // ② div/section/nav/aside/figure/button/form 都不该出现在 heading 里
      h.querySelectorAll("div, section, nav, aside, figure, button, form, label").forEach((n) =>
        n.remove()
      );
      // svg 装饰图标也清掉（heading 文字旁的链式锚标）
      h.querySelectorAll("svg").forEach((n) => n.remove());
      // 仅含空白的 anchor / span 一并去掉，避免 Turndown 产出空 []()
      h.querySelectorAll("a, span").forEach((n) => {
        if (!n.textContent || !n.textContent.trim()) n.remove();
      });
    });
  }

  // 把 <picture><source><img></picture> 拆开，只留下里面那张 <img>。
  // <picture> 本身在 Markdown / Notion 里没意义，留着只会让 Readability / Turndown
  // 多挑出几条 source 来扰动；提前拍扁更稳。
  //
  // 注意：不再把 <source srcset> 提升到 img 上 —— 那段 srcset 经常含逗号 URL
  // （Substack 等），即使解析对了，也只是替代 img 已有的良好 src，没收益。
  // 直接保留 img 自己的 src / srcset，让下游决定即可。
  function unwrapPicture(root) {
    root.querySelectorAll("picture").forEach((p) => {
      const img = p.querySelector("img");
      if (!img) {
        p.remove();
        return;
      }
      p.parentNode.insertBefore(img, p);
      p.remove();
    });
  }

  // 把"只裹了一张 <img>(可能再加 <picture>)的 <a>"展平为裸 img。
  // Substack / 公众号 / 知乎专栏都喜欢 <a href="大图url"><img src="缩略图url"></a>，
  // Turndown 会把它转成 [![alt](src)](href)，Notion 那边既不是图片块、链接也是包装地址，
  // 形成"空文本 + 失效链接"的脏数据。这里直接把外层 a 拆掉，让 img 单独存在。
  function unwrapImageAnchors(root) {
    root.querySelectorAll("a").forEach((a) => {
      const childImgs = a.querySelectorAll("img");
      if (!childImgs.length) return;
      // 如果 a 里除了空白和图片以外还有真正的文字，说明它是个真链接（带配图）—— 不动
      const text = (a.textContent || "").replace(/\s/g, "");
      if (text) return;
      // 如果 a 自己有 href 而 img 自身 src 是占位/无效，把 href 当作 img 的 src 备份
      const href = a.getAttribute("href") || "";
      childImgs.forEach((img) => {
        const cur = img.getAttribute("src") || "";
        if (href && (!cur || isPlaceholderSrc(cur))) {
          img.setAttribute("src", href);
        }
        a.parentNode.insertBefore(img, a);
      });
      a.remove();
    });
  }

  function absolutizeUrls(root, base) {
    root.querySelectorAll("a[href]").forEach((a) => {
      const v = a.getAttribute("href");
      if (!v) return;
      try {
        a.setAttribute("href", new URL(v, base).href);
      } catch (e) {}
    });

    root.querySelectorAll("img").forEach((img) => {
      const raw = resolveImgUrl(img);
      if (!raw) {
        // 纯占位图、没有可用源 → 干脆移除，避免在 Notion 里留下死链
        img.remove();
        return;
      }
      let abs;
      try {
        abs = new URL(raw, base).href;
      } catch (e) {
        img.remove();
        return;
      }
      abs = unwrapCdnProxy(abs);
      try {
        abs = new URL(abs, base).href;
      } catch (e) {}
      img.setAttribute("src", abs);
      // 已经选定一个 URL；清掉容易让下游再次猜错的属性
      img.removeAttribute("srcset");
      LAZY_SRC_ATTRS.forEach((a) => img.removeAttribute(a));
      LAZY_SRCSET_ATTRS.forEach((a) => img.removeAttribute(a));
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

    // 1) 清理 heading 内嵌套的装饰 div / 按钮 / SVG，避免 Readability 把它们当杂质连同标题一起删掉
    // 2) 拍扁 <picture>，让 img 浮到顶层
    // 3) 拆掉只包了 img 的 <a>，避免 Readability/Turndown 输出 [![](src)](href) 嵌套
    // 4) 把所有链接/图片绝对化，并解开 Substack 等代理 CDN 的包装
    sanitizeHeadings(docClone);
    unwrapPicture(docClone);
    unwrapImageAnchors(docClone);
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
    pollTimer = setInterval(checkUrlChange, 1200);
  }

  async function checkUrlChange() {
    // 扩展被 reload / 卸载后，这条定时器仍会跑；先探测 context，死了就自卸载
    if (!isExtensionAlive()) { cleanupOnInvalidated(); return; }
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
