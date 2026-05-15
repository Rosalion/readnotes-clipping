// content/highlighter.js
// 把一个 Range 包裹成高亮元素，以及拆除高亮。
// 同一套逻辑用于：
//   1) 当前网页（tagName=span, className=rnc-highlight，可点击编辑）
//   2) Readability 抽取出的离线正文（tagName=mark，用于导出）
//
// 暴露为全局对象 RNCHighlighter。

(function () {
  "use strict";

  function cssEsc(id) {
    return window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  }

  // 取出与 range 相交的全部文本节点
  function getTextNodesInRange(range) {
    if (!range || range.collapsed) return [];
    const container = range.commonAncestorContainer;
    if (container.nodeType === 3) return [container];
    const doc = container.ownerDocument || document;
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && range.intersectsNode(n)) nodes.push(n);
    }
    return nodes;
  }

  // 把 range 覆盖的文字逐段包进高亮元素。返回创建出的元素数组。
  function wrapRange(range, opts) {
    opts = opts || {};
    const doc = opts.doc || document;
    const tagName = opts.tagName || "span";
    const className = opts.className || "rnc-highlight";
    const id = opts.id;
    const color = opts.color || "yellow";

    const textNodes = getTextNodesInRange(range);
    const created = [];

    textNodes.forEach((node) => {
      let startOffset = 0;
      let endOffset = node.nodeValue.length;
      if (node === range.startContainer) startOffset = range.startOffset;
      if (node === range.endContainer) endOffset = range.endOffset;
      if (startOffset >= endOffset) return; // 这个节点上没有实际内容被选中

      // 把目标文字切成独立的文本节点
      let target = node;
      if (startOffset > 0) target = target.splitText(startOffset);
      if (endOffset - startOffset < target.nodeValue.length) {
        target.splitText(endOffset - startOffset);
      }

      const wrap = doc.createElement(tagName);
      wrap.className = className;
      if (id != null) wrap.setAttribute("data-rnc-id", id);
      wrap.setAttribute("data-rnc-color", color);
      target.parentNode.insertBefore(wrap, target);
      wrap.appendChild(target);
      created.push(wrap);
    });

    return created;
  }

  function unwrap(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize(); // 合并相邻文本节点，保证后续锚点定位干净
  }

  function removeHighlight(id, root) {
    root = root || document;
    root.querySelectorAll('[data-rnc-id="' + cssEsc(id) + '"]').forEach(unwrap);
  }

  function clearAll(root) {
    root = root || document;
    root.querySelectorAll(".rnc-highlight").forEach(unwrap);
  }

  // 切换某条高亮"是否带批注"的视觉标记（所有分段一起切换）
  function setNoteFlag(id, hasNote, root) {
    root = root || document;
    root.querySelectorAll('.rnc-highlight[data-rnc-id="' + cssEsc(id) + '"]').forEach((el) => {
      el.classList.toggle("rnc-has-note", !!hasNote);
    });
  }

  window.RNCHighlighter = {
    wrapRange,
    removeHighlight,
    clearAll,
    setNoteFlag,
    getTextNodesInRange,
  };
})();
