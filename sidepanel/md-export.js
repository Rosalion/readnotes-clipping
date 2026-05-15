// sidepanel/md-export.js
// 把"已注入划线/批注的正文 HTML"转换成 Markdown。
// 依赖全局 window.TurndownService（由 lib/turndown.js 以普通 <script> 引入）。

function makeTurndown() {
  if (!window.TurndownService) {
    throw new Error("Turndown 库未加载");
  }
  const td = new window.TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    hr: "---",
  });

  // <mark> —— 划线 —— 转成 Obsidian 高亮语法 ==text==
  td.addRule("rncMark", {
    filter: ["mark"],
    replacement: (content) => {
      const t = content.trim();
      return t ? "==" + t + "==" : content;
    },
  });

  // 批注占位块 —— 先转成占位符，稍后由 resolveNotePlaceholders 用真正的批注文本替换
  td.addRule("rncNotePlaceholder", {
    filter: (node) =>
      node.nodeName === "BLOCKQUOTE" && node.hasAttribute("data-rnc-note-id"),
    replacement: (content, node) =>
      "\n\n%%RNC_NOTE:" + node.getAttribute("data-rnc-note-id") + "%%\n\n",
  });

  return td;
}

// 把 %%RNC_NOTE:id%% 占位符替换成 Obsidian callout 形式的批注块
function resolveNotePlaceholders(md, highlights) {
  const byId = Object.create(null);
  (highlights || []).forEach((h) => {
    if (h && h.id) byId[h.id] = h;
  });
  return md.replace(/%%RNC_NOTE:([^%\s]+)%%/g, (m, id) => {
    const hl = byId[id];
    if (!hl || !hl.note || !hl.note.trim()) return "";
    const body = hl.note
      .trim()
      .split(/\r?\n/)
      .map((l) => "> " + l)
      .join("\n");
    return "> [!quote] 批注\n" + body;
  });
}

// 正文 HTML -> 正文 Markdown（批注占位符已替换，无 front matter）
export function clipToBodyMarkdown(clip) {
  const td = makeTurndown();
  let body = td.turndown((clip && clip.annotatedHtml) || "");
  body = resolveNotePlaceholders(body, clip && clip.highlights);
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return "";
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes())
  );
}
function yaml(s) {
  return (
    '"' +
    String(s == null ? "" : s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " ")
      .trim() +
    '"'
  );
}

// 文末的"划线与批注一览"，方便快速回顾
function buildAppendix(highlights) {
  const list = (highlights || []).filter((h) => h && (h.exact || h.note));
  if (!list.length) return "";
  const lines = ["---", "", "## 划线与批注一览", ""];
  list.forEach((h, i) => {
    const quote = (h.exact || "").replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. ==${quote}==`);
    if (h.note && h.note.trim()) {
      h.note
        .trim()
        .split(/\r?\n/)
        .forEach((l) => lines.push(`   > ${l}`));
    }
    if (h.resolved === false) {
      lines.push("   > _（此处未能在正文中定位，仅保留摘录）_");
    }
    lines.push("");
  });
  return lines.join("\n");
}

// 生成完整的 Markdown 文档（front matter + 标题 + 来源 + 正文 + 批注一览）
export function buildMarkdown(clip) {
  const body = clipToBodyMarkdown(clip);
  const date = formatDate(clip.clippedAt);

  const frontMatter = [
    "---",
    "title: " + yaml(clip.title),
    "source: " + (clip.url || ""),
    clip.byline ? "author: " + yaml(clip.byline) : null,
    "site: " + yaml(clip.siteName || ""),
    "clipped: " + date,
    "highlights: " + (clip.highlights || []).length,
    "tags: [clipping, 阅读剪藏]",
    "---",
  ]
    .filter((x) => x !== null)
    .join("\n");

  const header =
    "# " +
    (clip.title || "未命名文章") +
    "\n\n" +
    "> [!info] 来源\n" +
    "> [" +
    (clip.siteName || clip.url || "原文") +
    "](" +
    (clip.url || "") +
    ")" +
    (clip.byline ? " · " + clip.byline : "") +
    (date ? " · 剪藏于 " + date : "");

  const appendix = buildAppendix(clip.highlights);

  return (
    [frontMatter, header, body, appendix].filter((x) => x && x.trim()).join("\n\n") +
    "\n"
  );
}
