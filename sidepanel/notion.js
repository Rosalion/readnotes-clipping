// sidepanel/notion.js
// 与 Notion API 对接：测试连接、把剪藏的文章作为一个新页面写入指定 Database。
// 走 Internal Integration Token 方案（在设置页填写 Token + Database ID）。
// 由于扩展页拥有 host_permissions: https://api.notion.com/*，fetch 不受 CORS 限制。

import { clipToBodyMarkdown } from "./md-export.js";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function headers(token) {
  return {
    Authorization: "Bearer " + token,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(path, opts, token) {
  opts = opts || {};
  let res;
  try {
    res = await fetch(NOTION_BASE + path, {
      method: opts.method || "GET",
      headers: headers(token),
      body: opts.body,
    });
  } catch (e) {
    throw new Error("网络请求失败，请检查网络连接");
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* 可能是空响应 */
  }
  if (!res.ok) {
    const msg = data && data.message ? data.message : "HTTP " + res.status;
    throw new Error(msg);
  }
  return data;
}

// 接受裸 ID、带横线 ID，或直接粘贴的 Notion 链接
function cleanId(s) {
  s = String(s || "").trim();
  const m = s.match(
    /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/
  );
  if (m) return m[0].replace(/-/g, "");
  return s.replace(/[^0-9a-fA-F]/g, "");
}

function readSchema(db) {
  const props = (db && db.properties) || {};
  let titleProp = null;
  let urlProp = null;
  let dateProp = null;
  for (const name of Object.keys(props)) {
    const t = props[name] && props[name].type;
    if (t === "title" && !titleProp) titleProp = name;
    if (t === "url" && !urlProp) urlProp = name;
    if (t === "date" && !dateProp) dateProp = name;
  }
  return { titleProp, urlProp, dateProp };
}

function plainTitle(db) {
  const arr = (db && db.title) || [];
  return arr.map((t) => (t && t.plain_text) || "").join("") || "（未命名 Database）";
}

// 测试连接：返回 Database 名称与可写入的属性信息
export async function testNotion(settings) {
  if (!settings || !settings.token) throw new Error("未填写 Notion Token");
  if (!settings.databaseId) throw new Error("未填写 Database ID");
  const db = await notionFetch(
    "/databases/" + cleanId(settings.databaseId),
    { method: "GET" },
    settings.token
  );
  const schema = readSchema(db);
  if (!schema.titleProp) throw new Error("这个 Database 没有标题属性");
  return {
    ok: true,
    title: plainTitle(db),
    titleProp: schema.titleProp,
    hasUrl: !!schema.urlProp,
    hasDate: !!schema.dateProp,
  };
}

// ---------- Markdown -> Notion blocks ----------

const RICH_TEXT_LIMIT = 2000;

function makeRT(content, annotations, linkUrl) {
  const obj = { type: "text", text: { content: content == null ? "" : content } };
  if (linkUrl) obj.text.link = { url: linkUrl };
  if (annotations) obj.annotations = annotations;
  return obj;
}

// 把超过 2000 字的文本拆成多个 rich text 片段
function splitChunks(s) {
  s = String(s == null ? "" : s);
  if (s.length <= RICH_TEXT_LIMIT) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_LIMIT) {
    out.push(s.slice(i, i + RICH_TEXT_LIMIT));
  }
  return out;
}

function pushRT(arr, content, annotations, linkUrl) {
  for (const chunk of splitChunks(content)) {
    if (chunk === "" && arr.length) continue;
    arr.push(makeRT(chunk, annotations, linkUrl));
  }
}

// 去掉 Turndown 为正文里的字面量特殊字符加的反斜杠转义
function unescapeInline(s) {
  return String(s || "").replace(/\\([\\`*_~\[\]()#+\-.!>=])/g, "$1");
}

// 行内 Markdown -> Notion rich text 数组
function inlineToRichText(text) {
  text = unescapeInline(text);
  const out = [];
  // 依次匹配：==高亮== / **粗** / *斜* / `代码` / [文字](链接)
  const re =
    /(==([^=]+)==)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushRT(out, text.slice(last, m.index));
    if (m[1]) pushRT(out, m[2], { color: "yellow_background" });
    else if (m[3]) pushRT(out, m[4], { bold: true });
    else if (m[5]) pushRT(out, m[6], { italic: true });
    else if (m[7]) pushRT(out, m[8], { code: true });
    else if (m[9]) pushRT(out, m[10], null, m[11]);
    last = re.lastIndex;
  }
  if (last < text.length) pushRT(out, text.slice(last));
  // Notion 限制单个 block 最多 100 个 rich text 片段
  return out.slice(0, 100);
}

const NOTION_LANGS = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#",
  "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran",
  "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java",
  "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
  "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix",
  "objective-c", "ocaml", "pascal", "perl", "php", "plain text", "powershell",
  "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala",
  "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog",
  "vhdl", "visual basic", "webassembly", "xml", "yaml",
]);
function notionLang(l) {
  l = String(l || "").toLowerCase().trim();
  const alias = {
    js: "javascript", ts: "typescript", py: "python", sh: "shell",
    htm: "html", yml: "yaml", md: "markdown", text: "plain text", "": "plain text",
  };
  if (alias[l]) l = alias[l];
  return NOTION_LANGS.has(l) ? l : "plain text";
}

function paragraph(rt) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: rt } };
}

const SPECIAL_LINE = /^(#{1,3}\s|>\s?|```|\s*[-*+]\s|\s*\d+\.\s|!\[|\[!\[|\[\s*\]\()/;
const HR_LINE = /^(-{3,}|\*{3,}|_{3,})\s*$/;

// 兜底反包装：即使 content.js 漏了，也在这里把 Substack 的代理 URL 解出来
function unwrapForNotion(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (
      (host === "substackcdn.com" || host.endsWith(".substackcdn.com")) &&
      u.pathname.startsWith("/image/fetch/")
    ) {
      const m = u.pathname.match(/^\/image\/fetch\/[^/]+\/(.+)$/);
      if (m) {
        let inner = m[1];
        for (let i = 0; i < 3 && /%[0-9a-fA-F]{2}/.test(inner); i++) {
          inner = decodeURIComponent(inner);
          if (/^https?:\/\//i.test(inner)) break;
        }
        if (/^https?:\/\//i.test(inner)) return inner;
      }
    }
    if (host === "images.weserv.nl" || host === "wsrv.nl") {
      const pass = u.searchParams.get("url") || u.searchParams.get("src");
      if (pass) return /^https?:\/\//i.test(pass) ? pass : "https://" + pass;
    }
  } catch (e) {}
  return url;
}

function isUsableImageUrl(url) {
  return !!(url && /^https?:\/\//i.test(url) && url.length <= 2000 && !/\s/.test(url));
}

function pushImageBlock(blocks, url) {
  const cleaned = unwrapForNotion((url || "").trim());
  if (isUsableImageUrl(cleaned)) {
    blocks.push({
      object: "block",
      type: "image",
      image: { type: "external", external: { url: cleaned } },
    });
  }
}

export function markdownToBlocks(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // 代码块
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾的 ```
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: splitChunks(buf.join("\n")).map((c) => makeRT(c)),
          language: notionLang(lang),
        },
      });
      continue;
    }

    // 分隔线
    if (HR_LINE.test(line)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    // 标题（h1-h3）
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const type = "heading_" + h[1].length;
      blocks.push({
        object: "block",
        type,
        [type]: { rich_text: inlineToRichText(h[2].trim()) },
      });
      i++;
      continue;
    }

    // 引用 / callout（连续的 > 行）
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const callout = (buf[0] || "").match(/^\[!\w+\]\s*(.*)$/);
      if (callout) {
        const noteText = buf.slice(1).join("\n").trim() || callout[1].trim();
        blocks.push({
          object: "block",
          type: "callout",
          callout: {
            rich_text: inlineToRichText(noteText),
            icon: { type: "emoji", emoji: "📝" },
            color: "gray_background",
          },
        });
      } else {
        blocks.push({
          object: "block",
          type: "quote",
          quote: { rich_text: inlineToRichText(buf.join("\n").trim()) },
        });
      }
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const t = lines[i].replace(/^\s*[-*+]\s+/, "");
        blocks.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: inlineToRichText(t) },
        });
        i++;
      }
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const t = lines[i].replace(/^\s*\d+\.\s+/, "");
        blocks.push({
          object: "block",
          type: "numbered_list_item",
          numbered_list_item: { rich_text: inlineToRichText(t) },
        });
        i++;
      }
      continue;
    }

    // 独占一行的链接包图片 [![alt](src)](href) —— Substack / 公众号 常见
    // 取内层 src 当图片（href 通常是同一张图的 fetch 包装链，不必双写）
    const linkedImg = line.match(/^\[!\[[^\]]*\]\(([^)]+)\)\]\(([^)]+)\)\s*$/);
    if (linkedImg) {
      pushImageBlock(blocks, linkedImg[1]);
      i++;
      continue;
    }

    // 独占一行的图片
    const img = line.match(/^!\[[^\]]*\]\(([^)]+)\)\s*$/);
    if (img) {
      pushImageBlock(blocks, img[1]);
      i++;
      continue;
    }

    // "空链接独占一行" [](url) —— 上游 <a><img></a> 的 img 被剔走后留下的壳
    // 如果 url 看起来是个图片 / 已知图床，就当图片块；否则丢弃，避免空 paragraph
    const naked = line.match(/^\[\s*\]\(([^)]+)\)\s*$/);
    if (naked) {
      const candidate = unwrapForNotion(naked[1].trim());
      const looksLikeImage =
        /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(candidate) ||
        /substack-post-media\.s3\.amazonaws\.com/i.test(candidate) ||
        /substackcdn\.com\/image\//i.test(candidate);
      if (looksLikeImage) pushImageBlock(blocks, candidate);
      i++;
      continue;
    }

    // 普通段落：合并连续的普通行
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !SPECIAL_LINE.test(lines[i]) &&
      !HR_LINE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(paragraph(inlineToRichText(para.join("\n"))));
  }

  return blocks;
}

// ---------- 发送到 Notion ----------

export async function sendToNotion(clip, settings) {
  if (!settings || !settings.token) throw new Error("未填写 Notion Token");
  if (!settings.databaseId) throw new Error("未填写 Database ID");

  const dbId = cleanId(settings.databaseId);
  const db = await notionFetch("/databases/" + dbId, { method: "GET" }, settings.token);
  const schema = readSchema(db);
  if (!schema.titleProp) throw new Error("这个 Database 没有标题属性，无法写入");

  const bodyMd = clipToBodyMarkdown(clip);
  const contentBlocks = markdownToBlocks(bodyMd);

  // 顶部来源信息
  const headerBlock = {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [
        makeRT("来源：", { bold: true }),
        makeRT(clip.siteName || clip.url || "原文", null, clip.url || undefined),
        ...(clip.byline ? [makeRT("　·　" + clip.byline)] : []),
        ...(clip.clippedAt
          ? [makeRT("　·　剪藏于 " + clip.clippedAt.slice(0, 10))]
          : []),
      ],
      icon: { type: "emoji", emoji: "🔖" },
      color: "gray_background",
    },
  };

  const allBlocks = [headerBlock, ...contentBlocks];

  const properties = {
    [schema.titleProp]: {
      title: [{ type: "text", text: { content: (clip.title || "未命名文章").slice(0, 2000) } }],
    },
  };
  if (schema.urlProp && clip.url) properties[schema.urlProp] = { url: clip.url };
  if (schema.dateProp) {
    properties[schema.dateProp] = {
      date: { start: clip.clippedAt || new Date().toISOString() },
    };
  }

  const page = await notionFetch(
    "/pages",
    {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
        children: allBlocks.slice(0, 100),
      }),
    },
    settings.token
  );

  // Notion 单次最多 100 个 block，剩下的分批追加
  let rest = allBlocks.slice(100);
  while (rest.length) {
    const chunk = rest.slice(0, 100);
    rest = rest.slice(100);
    await notionFetch(
      "/blocks/" + page.id + "/children",
      { method: "PATCH", body: JSON.stringify({ children: chunk }) },
      settings.token
    );
  }

  return { ok: true, id: page.id, url: page.url || "" };
}
