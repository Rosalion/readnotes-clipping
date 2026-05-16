# 本地安装与 Obsidian 自动落盘

首次使用请复制配置示例：

```bash
cp scripts/save-server.config.example.json scripts/save-server.config.json
# 编辑 vaultDir 与 allowedRoots 为你的 Obsidian 路径
```

## 1. 启动保存服务（每次开机或开发前执行一次）

```bash
cd /Users/yilin/Desktop/project/readnotes-clipping
chmod +x scripts/*.sh
./scripts/start-save-server.sh
```

健康检查：`curl http://127.0.0.1:37564/health`

停止：`./scripts/stop-save-server.sh`

### 服务端配置（`scripts/save-server.config.json`）

| 字段 | 说明 |
|------|------|
| `vaultDir` | 默认 vault 目录；「按标题生成」路径的前缀 |
| `allowedRoots` | **白名单**：仅允许写入这些根目录下的 `.md` 文件 |
| `port` | 监听端口（默认 `37564`） |

修改 `allowedRoots` 或 `vaultDir` 后需 **重启** save-server。

## 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions` → **开发者模式**
2. **加载已解压的扩展程序** → 选择本目录 `readnotes-clipping`
3. 固定工具栏图标；**刷新**已打开的文章页

需要 Chrome **114+**。

## 3. 扩展设置与绝对路径导出

### 设置页（侧边栏 ⚙️ → Obsidian 落盘）

- **默认导出文件路径**：完整绝对路径（如 `/Users/你/.../文章.md`），新页面在侧边栏首次打开时作为初始值
- **导出时自动写入 Obsidian 目录**：开启后点击「导出 Markdown」会 POST 到本机 save-server
- **保存服务地址**：默认 `http://127.0.0.1:37564`

### 侧边栏

- **导出路径**：可按页单独填写并记忆；会覆盖设置页的默认值
- **按标题生成**：用 `vaultDir` + `YYYY-MM-DD_标题.md` 填充路径（需 save-server 已启动）

点击 **导出 Markdown** 时：将 Markdown 写入「导出路径」指定的绝对文件；父目录不存在时会自动创建。若路径不在 `allowedRoots` 内，服务端会拒绝并提示错误，扩展会回退为浏览器下载。

## 4. 故障排查

| 现象 | 处理 |
|------|------|
| 提示「保存服务未连接」 | 运行 `./scripts/start-save-server.sh` |
| 提示「路径不在允许的目录内」 | 在 `save-server.config.json` 的 `allowedRoots` 中加入目标目录的父路径，重启服务 |
| 扩展图标灰色 / 无法划线 | 刷新目标网页；确认不是 `chrome://` 页 |
| 正文抽不到 | 换静态文章页；SPA 站先导出再换路由 |
