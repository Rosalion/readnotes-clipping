// content/anchor.js
// 文本锚点（Text-Quote Anchor）。
// 思路与 W3C Web Annotation 的 TextQuoteSelector 一致：
// 用「选中文本 + 前后文 + 大致位置」来描述一处划线，
// 这样即使页面刷新、DOM 结构略有变化，也能重新定位到正确的文字范围。
// 同一套算法既用于"刷新后在原页面重新定位"，也用于"在 Readability 抽取出的正文里定位"。
//
// 暴露为全局对象 RNCAnchor：
//   RNCAnchor.createAnchor(range, root)  -> { exact, prefix, suffix, posHint }
//   RNCAnchor.resolveAnchor(anchor, root) -> Range | null

(function () {
  "use strict";

  const CONTEXT = 48; // 前后文各保留多少个字符

  // 构建锚点时跳过的元素（其文本不计入正文）
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SVG", "CANVAS",
    "AUDIO", "VIDEO", "IFRAME", "OBJECT", "TEMPLATE",
  ]);

  function normalizeText(s) {
    // 折叠所有连续空白为单个空格（不做首尾裁剪）
    return (s || "").replace(/\s+/g, " ");
  }

  function isSkipped(node, root) {
    let p = node.parentNode;
    while (p && p !== root) {
      if (p.nodeType === 1) {
        if (SKIP_TAGS.has(p.tagName)) return true;
        if (p.hasAttribute && p.hasAttribute("data-rnc-ui")) return true; // 插件自身的 UI
      }
      p = p.parentNode;
    }
    return false;
  }

  // 把 root 下的所有文本节点拼成一个字符串，并保留「字符偏移 -> 文本节点」的映射。
  // 同时生成「折叠空白后的归一化字符串」及其与原始偏移的对应关系。
  class TextMapper {
    constructor(root) {
      this.root = root;
      this.nodes = []; // { node, start, end } —— start/end 是 raw 中的偏移
      this.raw = "";

      const doc = root.ownerDocument || root;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          isSkipped(n, root) || !n.nodeValue
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });

      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue;
        if (!t) continue;
        const start = this.raw.length;
        this.raw += t;
        this.nodes.push({ node: n, start, end: this.raw.length });
      }

      // 归一化字符串 + norm->raw 偏移映射
      this.norm = "";
      this.normToRaw = [];
      let prevWs = false;
      for (let i = 0; i < this.raw.length; i++) {
        const isWs = /\s/.test(this.raw[i]);
        if (isWs) {
          if (prevWs) continue;
          prevWs = true;
          this.norm += " ";
        } else {
          prevWs = false;
          this.norm += this.raw[i];
        }
        this.normToRaw.push(i);
      }
      this.normToRaw.push(this.raw.length); // 末尾哨兵
    }

    // raw 偏移 -> { node, offset }
    // isEnd=false：取「包含该字符」的节点（区间左闭右开）
    // isEnd=true ：取「以该字符结尾」的节点（区间左开右闭）
    rawOffsetToPoint(raw, isEnd) {
      for (const seg of this.nodes) {
        const inside = isEnd
          ? raw > seg.start && raw <= seg.end
          : raw >= seg.start && raw < seg.end;
        if (inside) return { node: seg.node, offset: raw - seg.start };
      }
      if (this.nodes.length) {
        if (raw <= this.nodes[0].start) {
          return { node: this.nodes[0].node, offset: 0 };
        }
        const last = this.nodes[this.nodes.length - 1];
        return { node: last.node, offset: last.node.nodeValue.length };
      }
      return null;
    }

    rangeFromRaw(rawStart, rawEnd) {
      const a = this.rawOffsetToPoint(rawStart, false);
      const b = this.rawOffsetToPoint(rawEnd, true);
      if (!a || !b) return null;
      const doc = this.root.ownerDocument || this.root;
      const range = doc.createRange();
      try {
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch (e) {
        return null;
      }
      return range.collapsed ? null : range;
    }
  }

  function commonSuffixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }
  function commonPrefixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  // 由一个用户选区生成锚点。root 一般传 document.body。
  function createAnchor(range, root) {
    if (!range || range.collapsed) return null;
    const exactRaw = range.toString();
    if (!exactRaw || !exactRaw.trim()) return null;

    const doc = root.ownerDocument || document;
    let beforeText = "";
    let afterText = "";
    try {
      const pre = doc.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(range.startContainer, range.startOffset);
      beforeText = pre.toString();

      const suf = doc.createRange();
      suf.selectNodeContents(root);
      suf.setStart(range.endContainer, range.endOffset);
      afterText = suf.toString();
    } catch (e) {
      // 选区跨越了 root 之外等异常情况
      beforeText = "";
      afterText = "";
    }

    // 裁掉选中文本两端的空白，把它们并入前后文，避免高亮带上多余空格
    let lead = 0;
    let trail = 0;
    while (lead < exactRaw.length && /\s/.test(exactRaw[lead])) lead++;
    while (trail < exactRaw.length - lead && /\s/.test(exactRaw[exactRaw.length - 1 - trail])) trail++;
    const exact = exactRaw.slice(lead, exactRaw.length - trail);
    if (!exact) return null;

    return {
      exact,
      prefix: (beforeText + exactRaw.slice(0, lead)).slice(-CONTEXT),
      suffix: (exactRaw.slice(exactRaw.length - trail) + afterText).slice(0, CONTEXT),
      posHint: beforeText.length + lead,
    };
  }

  // 在 root 中根据锚点重新定位，返回一个 Range（失败返回 null）。
  function resolveAnchor(anchor, root) {
    if (!anchor || !anchor.exact) return null;
    const mapper = new TextMapper(root);
    const hay = mapper.norm;
    const needle = normalizeText(anchor.exact).trim();
    if (!needle) return null;

    // 收集所有出现位置
    const occ = [];
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      occ.push(idx);
      if (occ.length > 800) break;
      idx = hay.indexOf(needle, idx + 1);
    }
    if (!occ.length) return null;

    const normPrefix = normalizeText(anchor.prefix || "");
    const normSuffix = normalizeText(anchor.suffix || "");

    let best = occ[0];
    let bestScore = -Infinity;
    for (const o of occ) {
      let score = 0;
      // 前文吻合度
      if (normPrefix) {
        const before = hay.slice(Math.max(0, o - normPrefix.length), o);
        score += commonSuffixLen(before, normPrefix) * 2;
      }
      // 后文吻合度
      if (normSuffix) {
        const after = hay.slice(o + needle.length, o + needle.length + normSuffix.length);
        score += commonPrefixLen(after, normSuffix) * 2;
      }
      // 位置提示（仅作微调，权重最小）
      if (typeof anchor.posHint === "number") {
        score -= Math.min(40, Math.abs(o - anchor.posHint) / 60);
      }
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }

    const rawStart = mapper.normToRaw[best];
    const rawEnd = mapper.normToRaw[best + needle.length];
    if (rawStart == null || rawEnd == null) return null;
    return mapper.rangeFromRaw(rawStart, rawEnd);
  }

  window.RNCAnchor = { createAnchor, resolveAnchor, normalizeText, TextMapper };
})();
