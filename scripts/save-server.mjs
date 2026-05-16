#!/usr/bin/env node
/**
 * 本地保存服务：把扩展导出的 Markdown 写入 Obsidian vault。
 * 仅监听 127.0.0.1，无第三方依赖。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "save-server.config.json");

const DEFAULT_PORT = 37564;
const HOME = os.homedir();
const DEFAULT_VAULT = path.join(HOME, "Documents", "ObsidianVault", "Clippings");
const DEFAULT_ALLOWED_ROOTS = [
  path.join(HOME, "Documents"),
  path.join(HOME, "Desktop"),
];

function loadConfig() {
  let cfg = {
    port: DEFAULT_PORT,
    vaultDir: DEFAULT_VAULT,
    allowedRoots: DEFAULT_ALLOWED_ROOTS,
  };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    cfg = { ...cfg, ...JSON.parse(raw) };
  } catch {
    /* use defaults */
  }
  if (!Array.isArray(cfg.allowedRoots) || cfg.allowedRoots.length === 0) {
    cfg.allowedRoots = DEFAULT_ALLOWED_ROOTS;
  }
  cfg.allowedRoots = cfg.allowedRoots.map((r) => path.resolve(String(r)));
  return cfg;
}

function safeBasename(name) {
  const base = path.basename(String(name || "未命名.md"));
  if (!base.endsWith(".md")) return base.replace(/\.[^.]+$/, "") + ".md";
  return base;
}

function isUnderRoot(resolved, root) {
  const normalizedRoot = path.resolve(root);
  if (resolved === normalizedRoot) return false;
  return resolved.startsWith(normalizedRoot + path.sep);
}

function resolveSafeFilePath(filePath, allowedRoots) {
  const raw = String(filePath || "").trim();
  if (!raw) throw new Error("需要 filePath");
  if (!path.isAbsolute(raw)) {
    throw new Error("filePath 必须是绝对路径");
  }
  if (!raw.toLowerCase().endsWith(".md")) {
    throw new Error("仅允许写入 .md 文件");
  }
  const resolved = path.resolve(raw);
  if (resolved !== raw && resolved !== raw.replace(/\/+$/, "")) {
    /* path.resolve may normalize; still check traversal in input */
  }
  if (raw.includes("..")) {
    throw new Error("非法路径");
  }
  const allowed = allowedRoots.some((root) => isUnderRoot(resolved, root));
  if (!allowed) {
    throw new Error("路径不在允许的目录内（allowedRoots）");
  }
  return resolved;
}

function writeToVault(vaultDir, filename, content) {
  const resolvedVault = path.resolve(vaultDir);
  const target = path.resolve(resolvedVault, safeBasename(filename));
  if (!target.startsWith(resolvedVault + path.sep)) {
    throw new Error("非法文件名");
  }
  fs.mkdirSync(resolvedVault, { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function writeToAbsolutePath(filePath, content, allowedRoots) {
  const target = resolveSafeFilePath(filePath, allowedRoots);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

const config = loadConfig();
const port = Number(config.port) || DEFAULT_PORT;
const vaultDir = config.vaultDir || DEFAULT_VAULT;
const allowedRoots = config.allowedRoots;

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, {
      ok: true,
      vaultDir: path.resolve(vaultDir),
      port,
      allowedRoots,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/save") {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw || "{}");
      const content = data.content;
      if (typeof content !== "string") {
        send(res, 400, { ok: false, error: "需要 content" });
        return;
      }

      let filePath;
      if (data.filePath) {
        filePath = writeToAbsolutePath(data.filePath, content, allowedRoots);
      } else if (data.filename) {
        filePath = writeToVault(vaultDir, data.filename, content);
      } else {
        send(res, 400, {
          ok: false,
          error: "需要 filePath 或 filename",
        });
        return;
      }

      console.log(`[save-server] wrote ${filePath}`);
      send(res, 200, {
        ok: true,
        path: filePath,
        filename: path.basename(filePath),
      });
    } catch (e) {
      console.error("[save-server]", e);
      send(res, 500, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[save-server] http://127.0.0.1:${port}/health`);
  console.log(`[save-server] vault → ${path.resolve(vaultDir)}`);
  console.log(`[save-server] allowedRoots → ${allowedRoots.join(", ")}`);
});
