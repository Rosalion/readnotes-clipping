<h1 align="center">阅读剪藏 · 划线批注</h1>

<p align="center">
  <em>边读、边划、边写 —— 把文章和你的批注一起带走。</em>
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-2d5239?style=flat-square" />
  <img alt="Chrome 114+" src="https://img.shields.io/badge/Chrome-114%2B-3a6b48?style=flat-square" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-9c7a3c?style=flat-square" />
  <img alt="No build step" src="https://img.shields.io/badge/build-vanilla%20JS-a8472f?style=flat-square" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-5b9279?style=flat-square" />
</p>

> 一款 Chrome 扩展（Manifest V3）：在网页里**划线**、**写批注**，再把**正文 + 你的批注**一次性以 **Markdown** 导出（放进 Obsidian 即用）或**发送到 Notion**。正文抓取参考 *Copy to Notion* 的思路 —— 用 Mozilla **Readability** 按 DOM 智能识别文章主体，再把你的划线和批注按原文位置注入回去。

---

## 目录

- [✨ 它做什么](#-它做什么)
- [🖼 界面预览](#-界面预览)
- [🚀 安装](#-安装)
- [📖 使用](#-使用)
- [🔗 配置 Notion](#-配置-notion)
- [🧠 工作原理](#-工作原理)
- [📁 项目结构](#-项目结构)
- [🔒 隐私](#-隐私)
- [⚠️ 已知限制](#️-已知限制)
- [🛠 开发](#-开发)
- [🙏 致谢](#-致谢)
- [📄 许可](#-许可)

---

## ✨ 它做什么

| 场景 | 做法 |
| --- | --- |
| **划线** | 网页里选中文字，弹出工具条，选颜色（黄 / 绿 / 蓝 / 粉）即可。 |
| **写批注** | 工具条里点「划线 + 批注」，写注释，⌘/Ctrl + Enter 保存。 |
| **改 / 删** | 直接点页面里的划线，或在侧边栏卡片上操作。 |
| **侧边栏** | Chrome 原生 Side Panel：点工具栏图标即开 / 收；切换标签页自动跟随，显示当前页的所有划线与批注。 |
| **持久化** | 划线按规范化 URL 存进 `chrome.storage.local`，刷新页面后用文本锚点（前后文 + 位置）重新定位还原。 |
| **一键清除** | 勾「清除后刷新页面」立即抹掉本页全部划线；不勾则只清记录，页面上已渲染的标记保留到你下次手动刷新为止。 |
| **导出 Markdown** | 智能抓取正文，划线转 `==高亮==`，批注转 Obsidian Callout，并附带 front matter 与「划线与批注一览」附录。 |
| **发送到 Notion** | 同一份内容作为新页面写入你指定的 Database，标题 / 来源链接 / 剪藏日期自动填入对应属性。 |

---

## 🖼 界面预览

<!--
  在这里替换为你的截图。建议放进 docs/screenshots/ 目录后再引用：
  ![侧边栏](docs/screenshots/sidepanel.png)
  ![网页内划线工具条](docs/screenshots/in-page-toolbar.png)
  ![设置页](docs/screenshots/options.png)
-->

> 截图待补。设计基调是「**森林绿 · 田野笔记**」：奶油纸底、森林绿、暖暖的木纹与黏土色，
> 标题用 Fraunces 衬线（中文回退到宋体类），划线卡片像账本里的一"叶"。
> 注入到网页里的高亮 / 工具条用克制的自然颜料色，不抢走你阅读的注意力。

---

## 🚀 安装

> 暂未上架 Chrome Web Store，目前以「开发者模式」加载本仓库即可。

1. 克隆或下载本仓库到本地任意位置。
2. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选中本项目根目录 `read-notes-clipping`。
4. 把扩展图标固定到工具栏（便于一键开关侧边栏）。

> 已经打开的旧标签页需要**手动刷新一次**，内容脚本才会注入进去。

需要 Chrome **114+**（Side Panel API 起步版本）。Edge / Brave / Arc 等基于 Chromium 的浏览器同理。

---

## 📖 使用

| 操作 | 方式 |
| --- | --- |
| 开 / 关侧边栏 | 点工具栏的扩展图标（再次点击即收起） |
| 划线 | 网页中选中文字 → 工具条里点颜色 |
| 划线并批注 | 选中文字 → 工具条「划线 + 批注」→ 写注释（⌘/Ctrl + Enter 保存） |
| 改 / 删批注 | 点页面里的划线，或在侧边栏卡片上操作 |
| 定位 | 侧边栏点某条划线的引用文字，页面滚动并高亮闪烁 |
| 导出 / 发送 / 清除 | 侧边栏底部按钮 |
| 打开设置 | 侧边栏右上角的齿轮图标 |

---

## 🔗 配置 Notion

在扩展的**设置页**（侧边栏右上角 ⚙️）填写两项：

1. **Integration Token**
   去 [notion.so/my-integrations](https://www.notion.so/my-integrations) 新建一个 **Internal Integration**，复制它的 Token（`ntn_` 或 `secret_` 开头）。
2. **目标 Database ID**
   - 打开你想存文章的 Database 页面；
   - 右上角「···」→「Connections / 连接」→ 把刚才创建的集成加进去（否则 API 无权限）；
   - 复制该 Database 页面的链接粘贴到设置页即可（裸 ID 也行）。

点 **测试连接** 确认无误后保存。之后侧边栏的「发送到 Notion」就能用了。

> **Database 建议字段**：必须有一个 **Title** 属性；可选 **URL** 属性（自动填来源链接）、**Date** 属性（自动填剪藏日期）。属性名识别支持中英文常见命名。

---

## 🧠 工作原理

```
选中文字
  └─► 内容脚本生成「文本锚点」（前后文 + 字符位置）
        └─► 包成 <mark>，存进 chrome.storage.local（按规范化 URL 归档）
              └─► 页面刷新后 → 用锚点重新定位 → 重新包高亮

点「导出 / 发送」
  └─► 克隆当前文档，绝对化链接
        └─► Readability 抽取正文
              └─► 把每条划线在抽取后的正文里重新定位，包 <mark>
                    └─► 在对应段落后插入批注占位块
                          ├─► Turndown → Markdown（带 front matter 与附录）
                          └─► Markdown → Notion blocks → Notion API
```

- **锚点（anchor）**：选中文字 + 前后 N 个字符 + 起止偏移，构成对 DOM 改动相对鲁棒的定位信息。
- **Readability**：与 Firefox 阅读模式同款的正文抽取库，过滤导航 / 广告 / 评论。
- **Turndown**：HTML → Markdown 转换，已配置好对 `<mark>`、批注块和链接的处理。
- **Notion**：走 Internal Integration Token，不需要任何后端服务器。

---

## 📁 项目结构

```
read-notes-clipping/
├── manifest.json              MV3 配置
├── background/
│   └── service-worker.js      让扩展图标开 / 关侧边栏（setPanelBehavior）
├── content/
│   ├── anchor.js              文本锚点：选中文字 + 前后文 → 可重新定位的锚点
│   ├── highlighter.js         把 Range 包成高亮元素 / 拆除高亮
│   ├── content.js             选区工具条、批注弹层、持久化、剪藏正文、与侧边栏通信
│   └── content.css            高亮 / 工具条 / 弹层样式
├── sidepanel/
│   ├── sidepanel.html / .css / .js   侧边栏 UI，跟随当前标签页
│   ├── md-export.js           正文 HTML → Markdown（含划线与批注）
│   └── notion.js              Markdown → Notion blocks，调用 Notion API
├── options/                   设置页（Notion Token / Database / 默认颜色）
├── lib/
│   ├── Readability.js         Mozilla Readability（正文抽取，vendored）
│   └── turndown.js            HTML → Markdown（vendored）
├── assets/fonts/              Fraunces 显示字体（拉丁子集，侧边栏 / 设置页用）
├── icons/                     森林绿叶子图标（由 scripts/make-icons.mjs 生成）
└── scripts/make-icons.mjs     纯 Node 生成 PNG 图标，无第三方依赖
```

---

## 🔒 隐私

- 划线、批注、设置都只存在你本机的 `chrome.storage.local` 里。
- Notion Integration Token 同样**只存本机**，不会上传到任何服务器。
- 除了你**主动**点「发送到 Notion」时向 `https://api.notion.com/*` 发起的请求外，本扩展不向任何外部服务发请求；没有埋点、没有分析、没有遥测。
- `host_permissions` 仅声明 `https://api.notion.com/*`；内容脚本运行在你浏览的页面里，但页面正文只在你点「导出 / 发送」时本地被读取处理，处理结果不会上传任何第三方。

---

## ⚠️ 已知限制

- **SPA 路由切换**：单页应用换路由后扩展会尝试重新定位划线，若 DOM 结构变化较大，个别划线可能定位失败（导出时会在「划线与批注一览」里标注）。
- **「清除本页」不刷新**：页面上已渲染的高亮标记会保留到手动刷新；此时点击它们不再响应（记录已清空）。
- **奇异页面**：Readability 对结构怪异、严重依赖动态渲染的页面可能识别不到正文。
- **边界情况**：重叠划线、跨复杂表格的划线可能显示异常。
- **浏览器版本**：依赖 Chrome **114+**（Side Panel API）。

---

## 🛠 开发

无构建步骤，纯原生 JS。改完代码在 `chrome://extensions` 点扩展的「刷新」按钮即可生效。内容脚本相关改动需要刷新被注入的页面。

```bash
# 重新生成图标（修改 SVG 或尺寸后）
node scripts/make-icons.mjs
```

第三方库（`lib/Readability.js`、`lib/turndown.js`）已随仓库 vendored，**无需** `npm install`。

欢迎以 Issue / PR 形式反馈。提交 PR 时请保持现有的代码风格（2 空格缩进、ES Modules、不引入构建工具）。

---

## 🙏 致谢

本项目站在以下开源工作的肩膀上：

| 组件 | 用途 | 协议 |
| --- | --- | --- |
| [Mozilla Readability](https://github.com/mozilla/readability) | 正文抽取 | Apache-2.0 |
| [Turndown](https://github.com/mixmark-io/turndown) | HTML → Markdown | MIT |
| [Lucide Icons](https://lucide.dev) | 侧边栏齿轮图标 | ISC |
| [Fraunces](https://fonts.google.com/specimen/Fraunces) | 显示字体 | SIL OFL 1.1 |

灵感来源：*Copy to Notion*、Hypothes.is、Readwise Reader、Obsidian 的高亮与 Callout 语法。

---

## 📄 许可

本项目代码以 **[MIT](LICENSE)** 协议开源。
vendored 的第三方库各自保留原协议（见 [致谢](#-致谢)）。
