// sidepanel/sidepanel.js
// 侧边栏主逻辑：跟随当前标签页显示其划线 / 批注，并提供导出 / 发送 / 清除。

import { buildMarkdown } from "./md-export.js";
import { sendToNotion } from "./notion.js";

const NS = "rnc:";
const SETTINGS_KEY = "rnc:settings";
const SVG_NS = "http://www.w3.org/2000/svg";

const ctx = {
  tabId: null,
  url: null,
  tabTitle: "",
  key: null,
  record: null,
  supported: false,
};
let editingId = null; // 正在面板里编辑批注的划线 id（避免被自动刷新打断）
let toastTimer = null;
let vaultHealthCache = { at: 0, data: null };
const VAULT_HEALTH_TTL_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// ---------- 工具 ----------
function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = "";
    return u.origin + u.pathname + u.search;
  } catch (e) {
    return href || "";
  }
}
function pageKeyFor(href) {
  return NS + normalizeUrl(href);
}
function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}
function safeFilename(name) {
  return (
    String(name || "未命名文章")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "未命名文章"
  );
}
function datedExportFilename(title) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date =
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  return date + "_" + safeFilename(title) + ".md";
}
function joinPath(dir, name) {
  return String(dir || "").replace(/\/+$/, "") + "/" + name;
}
function basenameFromPath(filePath) {
  const p = String(filePath || "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function validateExportFilePath(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return { ok: false, error: "请填写导出路径" };
  if (!p.startsWith("/")) {
    return { ok: false, error: "请使用绝对路径（以 / 开头）" };
  }
  if (!p.toLowerCase().endsWith(".md")) {
    return { ok: false, error: "路径须以 .md 结尾" };
  }
  return { ok: true, path: p };
}
function downloadMarkdown(md, filename) {
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function saveToVaultServer(md, filePath, settings) {
  const base = (settings.saveServerUrl || "http://127.0.0.1:37564").replace(
    /\/+$/,
    ""
  );
  const resp = await fetch(base + "/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePath, content: md }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || "保存服务返回 " + resp.status);
  }
  return data;
}
async function pingSaveServer(settings) {
  const base = (settings.saveServerUrl || "http://127.0.0.1:37564").replace(
    /\/+$/,
    ""
  );
  const resp = await fetch(base + "/health", { method: "GET" });
  if (!resp.ok) throw new Error("health " + resp.status);
  return resp.json();
}
async function getVaultHealth(settings) {
  if (
    vaultHealthCache.data &&
    Date.now() - vaultHealthCache.at < VAULT_HEALTH_TTL_MS
  ) {
    return vaultHealthCache.data;
  }
  const data = await pingSaveServer(settings);
  vaultHealthCache = { at: Date.now(), data };
  return data;
}
async function resolveExportFilePathForDisplay() {
  const record = ctx.record;
  if (record && record.exportFilePath) return record.exportFilePath;
  const settings = await getSettings();
  if (settings.defaultExportFilePath) return settings.defaultExportFilePath;
  const title = (record && record.title) || ctx.tabTitle || "未命名文章";
  try {
    const health = await getVaultHealth(settings);
    if (health && health.vaultDir) {
      return joinPath(health.vaultDir, datedExportFilename(title));
    }
  } catch {
    /* 服务未启动时留空 */
  }
  return "";
}
async function persistExportFilePath(filePath) {
  if (!ctx.key) return;
  const prev = ctx.record || {
    url: normalizeUrl(ctx.url),
    title: ctx.tabTitle || "",
    highlights: [],
  };
  const next = { ...prev, exportFilePath: filePath };
  ctx.record = next;
  await chrome.storage.local.set({ [ctx.key]: next });
}
async function syncExportPathInput() {
  const input = $("exportFilePath");
  const btn = $("btnSuggestPath");
  if (!ctx.supported) {
    input.value = "";
    input.disabled = true;
    btn.disabled = true;
    return;
  }
  input.disabled = false;
  btn.disabled = false;
  input.value = await resolveExportFilePathForDisplay();
}
async function suggestExportPathFromTitle() {
  const title = (ctx.record && ctx.record.title) || ctx.tabTitle || "未命名文章";
  const settings = await getSettings();
  try {
    const health = await getVaultHealth(settings);
    if (health && health.vaultDir) {
      const p = joinPath(health.vaultDir, datedExportFilename(title));
      $("exportFilePath").value = p;
      await persistExportFilePath(p);
      return;
    }
  } catch (e) {
    toast("无法连接保存服务：" + (e.message || e), "error");
    return;
  }
  toast("未获取到 vault 目录", "error");
}
function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " 天前";
  const date = new Date(ts);
  return date.getMonth() + 1 + " 月 " + date.getDate() + " 日";
}

function leafSvg(className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  if (className) svg.setAttribute("class", className);
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("d", "M12 2C17 7 17 16 12 22C7 16 7 7 12 2Z");
  body.setAttribute("fill", "#a9bdab");
  const rib = document.createElementNS(SVG_NS, "path");
  rib.setAttribute("d", "M12 2.8V21.4");
  rib.setAttribute("stroke", "#5f8068");
  rib.setAttribute("stroke-width", "1");
  rib.setAttribute("stroke-linecap", "round");
  const veins = document.createElementNS(SVG_NS, "path");
  veins.setAttribute(
    "d",
    "M12 8.8 15.7 6.4M12 8.8 8.3 6.4M12 13.4 16 11.2M12 13.4 8 11.2"
  );
  veins.setAttribute("stroke", "#5f8068");
  veins.setAttribute("stroke-width", "0.8");
  veins.setAttribute("stroke-linecap", "round");
  svg.appendChild(body);
  svg.appendChild(rib);
  svg.appendChild(veins);
  return svg;
}

function toast(msg, type = "info", duration = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + type;
  t.hidden = false;
  // 重启入场动画
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  if (duration > 0) {
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, duration);
  }
}
function toastWithLink(msg, type, linkText, linkUrl) {
  const t = $("toast");
  t.className = "toast " + type;
  t.textContent = msg + " ";
  const a = document.createElement("a");
  a.textContent = linkText;
  a.href = linkUrl;
  a.target = "_blank";
  a.rel = "noreferrer";
  t.appendChild(a);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 9000);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: "NO_CONTENT_SCRIPT" });
        } else {
          resolve(resp || { ok: false, error: "EMPTY" });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return data[SETTINGS_KEY] || {};
}

async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.classList.add("is-busy");
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.classList.remove("is-busy");
    btn.disabled = false;
  }
}

// ---------- 数据加载 ----------
async function refresh() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || "")) {
    ctx.tabId = tab ? tab.id : null;
    ctx.url = tab ? tab.url : null;
    ctx.tabTitle = tab ? tab.title || "" : "";
    ctx.key = null;
    ctx.record = null;
    ctx.supported = false;
    await syncExportPathInput();
    render();
    return;
  }
  ctx.tabId = tab.id;
  ctx.url = tab.url;
  ctx.tabTitle = tab.title || "";
  ctx.key = pageKeyFor(tab.url);
  ctx.supported = true;
  const data = await chrome.storage.local.get(ctx.key);
  ctx.record = data[ctx.key] || {
    url: normalizeUrl(tab.url),
    title: tab.title || "",
    highlights: [],
  };
  await syncExportPathInput();
  render();
}

// ---------- 渲染 ----------
function setFooterEnabled(enabled) {
  $("btnExport").disabled = !enabled;
  $("btnNotion").disabled = !enabled;
  $("btnClear").disabled = !enabled;
  if ($("exportFilePath")) $("exportFilePath").disabled = !enabled;
  if ($("btnSuggestPath")) $("btnSuggestPath").disabled = !enabled;
}

function makePlaceholder(title, hint) {
  const ph = document.createElement("div");
  ph.className = "placeholder";
  ph.appendChild(leafSvg("ph-leaf"));
  const t = document.createElement("div");
  t.className = "ph-title";
  t.textContent = title;
  const h = document.createElement("div");
  h.className = "ph-hint";
  h.textContent = hint;
  ph.appendChild(t);
  ph.appendChild(h);
  return ph;
}

function render() {
  const ledger = $("ledger");

  if (!ctx.supported) {
    $("entryKicker").textContent = "不可用";
    $("entryTitle").textContent = "当前页面不支持划线";
    $("entryMeta").textContent = "";
    ledger.innerHTML = "";
    ledger.appendChild(
      makePlaceholder(
        "这一页无法剪藏",
        "浏览器内置页、扩展页、应用商店等无法注入。打开一篇普通网页文章再试试。"
      )
    );
    setFooterEnabled(false);
    return;
  }

  const record = ctx.record;
  const highlights = (record && record.highlights) || [];

  $("entryKicker").textContent = "正在阅读";
  $("entryTitle").textContent =
    (record && record.title) || ctx.tabTitle || "未命名文章";

  const meta = $("entryMeta");
  meta.innerHTML = "";
  const host = document.createElement("span");
  host.className = "meta-host";
  host.textContent = hostOf(ctx.url) || "本页";
  meta.appendChild(host);
  if (highlights.length) {
    const dot = document.createElement("span");
    dot.className = "meta-dot";
    dot.textContent = "·";
    meta.appendChild(dot);
    const cnt = document.createElement("span");
    cnt.className = "meta-count";
    cnt.textContent = highlights.length + " 处划线";
    meta.appendChild(cnt);
  }

  setFooterEnabled(true);

  ledger.innerHTML = "";
  if (!highlights.length) {
    ledger.appendChild(
      makePlaceholder(
        "本页还没有划线",
        "在网页中选中文字，就能划线、写批注。它们会留在这里，随文章一起导出。"
      )
    );
    return;
  }

  const sorted = highlights
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  sorted.forEach((hl, i) => ledger.appendChild(renderCard(hl, i)));
}

function renderCard(hl, index) {
  const card = document.createElement("article");
  card.className = "leaf-card";
  card.dataset.color = hl.color || "yellow";
  card.dataset.id = hl.id;
  card.style.animationDelay = Math.min(index * 45, 360) + "ms";

  const quote = document.createElement("div");
  quote.className = "leaf-quote";
  quote.textContent = (hl.anchor && hl.anchor.exact) || hl.exact || "（空）";
  quote.title = "点击在页面中定位";
  quote.addEventListener("click", () => jumpTo(hl.id));
  card.appendChild(quote);

  if (editingId === hl.id) {
    card.appendChild(buildNoteEditor(hl));
    return card;
  }

  const hasNote = !!(hl.note && hl.note.trim());
  if (hasNote) {
    const note = document.createElement("div");
    note.className = "leaf-note";
    note.textContent = hl.note;
    card.appendChild(note);
  } else {
    const add = document.createElement("button");
    add.className = "leaf-note-add";
    add.textContent = "＋ 写批注";
    add.addEventListener("click", () => {
      editingId = hl.id;
      render();
    });
    card.appendChild(add);
  }

  const foot = document.createElement("div");
  foot.className = "leaf-foot";

  const time = document.createElement("span");
  time.className = "leaf-time";
  time.textContent = relativeTime(hl.createdAt);
  foot.appendChild(time);

  const acts = document.createElement("div");
  acts.className = "leaf-actions";

  const locate = document.createElement("button");
  locate.textContent = "定位";
  locate.addEventListener("click", () => jumpTo(hl.id));
  acts.appendChild(locate);

  if (hasNote) {
    const edit = document.createElement("button");
    edit.textContent = "编辑批注";
    edit.addEventListener("click", () => {
      editingId = hl.id;
      render();
    });
    acts.appendChild(edit);
  }

  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "删除";
  del.addEventListener("click", () => deleteHighlight(hl.id));
  acts.appendChild(del);

  foot.appendChild(acts);
  card.appendChild(foot);
  return card;
}

function buildNoteEditor(hl) {
  const wrap = document.createElement("div");
  wrap.className = "note-editor";

  const ta = document.createElement("textarea");
  ta.value = hl.note || "";
  ta.placeholder = "写下你的批注…（⌘ / Ctrl + Enter 保存）";
  wrap.appendChild(ta);

  const row = document.createElement("div");
  row.className = "editor-actions";

  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    editingId = null;
    render();
  });

  const save = document.createElement("button");
  save.className = "save";
  save.textContent = "保存";
  const doSave = async () => {
    const note = ta.value.trim();
    hl.note = note;
    editingId = null;
    const resp = await sendToTab(ctx.tabId, {
      type: "rnc-update-note",
      id: hl.id,
      note,
    });
    if (!resp.ok && resp.error === "NO_CONTENT_SCRIPT") {
      await persistRecord();
    }
    render();
    toast("批注已保存", "success");
  };
  save.addEventListener("click", doSave);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doSave();
    if (e.key === "Escape") {
      editingId = null;
      render();
    }
  });

  row.appendChild(cancel);
  row.appendChild(save);
  wrap.appendChild(row);

  setTimeout(() => ta.focus(), 0);
  return wrap;
}

// 兜底：内容脚本不可用时，侧边栏直接写回存储
async function persistRecord() {
  if (!ctx.key || !ctx.record) return;
  ctx.record.updatedAt = Date.now();
  await chrome.storage.local.set({ [ctx.key]: ctx.record });
}

// ---------- 交互动作 ----------
async function jumpTo(id) {
  if (!ctx.tabId) return;
  const resp = await sendToTab(ctx.tabId, { type: "rnc-scroll-to", id });
  if (!resp.ok) {
    if (resp.error === "NO_CONTENT_SCRIPT") toast("请刷新该网页后重试", "error");
    else toast(resp.error || "无法定位该划线", "error");
  }
}

async function deleteHighlight(id) {
  if (!confirm("确定删除这条划线吗？")) return;
  if (ctx.record) {
    ctx.record.highlights = ctx.record.highlights.filter((h) => h.id !== id);
  }
  const resp = await sendToTab(ctx.tabId, { type: "rnc-delete", id });
  if (!resp.ok && resp.error === "NO_CONTENT_SCRIPT") {
    await persistRecord();
  }
  render();
  toast("已删除", "success");
}

async function requestClip() {
  if (!ctx.tabId) {
    toast("当前页面不支持剪藏", "error");
    return null;
  }
  toast("正在按 DOM 抓取正文…", "info", 0);
  const resp = await sendToTab(ctx.tabId, { type: "rnc-clip" });
  if (!resp.ok) {
    if (resp.error === "NO_CONTENT_SCRIPT") toast("请刷新该网页后重试", "error");
    else toast("剪藏失败：" + (resp.error || "未知错误"), "error");
    return null;
  }
  return resp.clip;
}

async function doExport() {
  const clip = await requestClip();
  if (!clip) return;
  try {
    const settings = await getSettings();
    const md = buildMarkdown(clip);
    const filePathInput = ($("exportFilePath").value || "").trim();
    const n = (clip.highlights || []).length;
    const suffix = n ? "（含 " + n + " 处划线）" : "";

    if (settings.autoSaveToVault !== false) {
      const v = validateExportFilePath(filePathInput);
      if (!v.ok) {
        toast(v.error, "error");
        return;
      }
      await persistExportFilePath(v.path);
      try {
        const saved = await saveToVaultServer(md, v.path, settings);
        toast(
          "已写入：" + (saved.path || v.path) + suffix,
          "success",
          4500
        );
        return;
      } catch (e) {
        console.warn("[阅读剪藏] vault save failed:", e);
        toast(
          "保存失败：" + (e.message || e) + "，改为下载…",
          "info",
          3000
        );
      }
    }

    const dlName = filePathInput
      ? basenameFromPath(filePathInput)
      : datedExportFilename(clip.title);
    downloadMarkdown(md, dlName);
    toast("已下载 Markdown：" + dlName + suffix, "success");
  } catch (e) {
    toast("导出失败：" + (e.message || e), "error");
  }
}

async function doNotion() {
  const settings = await getSettings();
  if (!settings.token || !settings.databaseId) {
    toast("请先在设置里填写 Notion Token 和 Database ID", "error");
    chrome.runtime.openOptionsPage();
    return;
  }
  const clip = await requestClip();
  if (!clip) return;
  toast("正在发送到 Notion…", "info", 0);
  try {
    const r = await sendToNotion(clip, settings);
    if (r.url) {
      toastWithLink("已发送到 Notion", "success", "打开页面 ↗", r.url);
    } else {
      toast("已发送到 Notion", "success");
    }
  } catch (e) {
    toast("发送失败：" + (e.message || e), "error");
  }
}

async function doClear() {
  if (!ctx.tabId) return;
  const reload = $("chkReload").checked;
  const msg = reload
    ? "将清除本页所有划线与批注，并刷新页面。继续？"
    : "将清除本页的划线 / 批注记录。\n（页面上已显示的标记会保留，直到你手动刷新）继续？";
  if (!confirm(msg)) return;

  const resp = await sendToTab(ctx.tabId, { type: "rnc-clear", reload });
  if (!resp.ok && resp.error === "NO_CONTENT_SCRIPT") {
    await chrome.storage.local.remove(ctx.key);
  }
  ctx.record = {
    url: normalizeUrl(ctx.url),
    title: ctx.record ? ctx.record.title : ctx.tabTitle,
    highlights: [],
  };
  render();
  toast(
    reload
      ? "已清除并刷新页面"
      : "已清除本页记录（页面标记将在刷新后消失）",
    "success"
  );
}

// ---------- 事件绑定 ----------
function bindEvents() {
  $("btnSettings").addEventListener("click", () =>
    chrome.runtime.openOptionsPage()
  );
  $("btnExport").addEventListener("click", (e) =>
    withBusy(e.currentTarget, doExport)
  );
  $("btnNotion").addEventListener("click", (e) =>
    withBusy(e.currentTarget, doNotion)
  );
  $("btnClear").addEventListener("click", doClear);
  $("btnSuggestPath").addEventListener("click", () =>
    withBusy($("btnSuggestPath"), suggestExportPathFromTitle)
  );
  $("exportFilePath").addEventListener("blur", async () => {
    if (!ctx.key || !ctx.supported) return;
    const p = ($("exportFilePath").value || "").trim();
    if (p === ((ctx.record && ctx.record.exportFilePath) || "")) return;
    await persistExportFilePath(p);
  });

  let refreshTimer = null;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 80);
  };

  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.windows.onFocusChanged.addListener((winId) => {
    if (winId !== chrome.windows.WINDOW_ID_NONE) scheduleRefresh();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== ctx.tabId) return;
    if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
      scheduleRefresh();
    }
  });

  // 存储变化（来自内容脚本的划线增删改）-> 局部刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !ctx.key) return;
    if (changes[ctx.key]) {
      if (editingId) return; // 正在编辑批注，先不打断
      ctx.record = changes[ctx.key].newValue || {
        url: normalizeUrl(ctx.url),
        title: ctx.record ? ctx.record.title : ctx.tabTitle,
        highlights: [],
      };
      render();
    }
  });
}

// ---------- 启动 ----------
bindEvents();
refresh();
