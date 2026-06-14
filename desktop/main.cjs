const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const { existsSync, readFileSync, statSync } = require("node:fs");
const { extname, isAbsolute, join, resolve } = require("node:path");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitIndex = trimmed.indexOf("=");
    if (splitIndex <= 0) continue;
    const key = trimmed.slice(0, splitIndex).trim();
    let value = trimmed.slice(splitIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function mimeType(filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".json": "application/json; charset=utf-8"
  };
  return types[extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function startDesktopServer() {
  const projectRoot = resolve(__dirname, "..");
  loadEnvFile(resolve(projectRoot, ".env.local"));
  if (process.env.AI_WORKFLOW_DOC_PATH && !isAbsolute(process.env.AI_WORKFLOW_DOC_PATH)) {
    process.env.AI_WORKFLOW_DOC_PATH = resolve(projectRoot, process.env.AI_WORKFLOW_DOC_PATH);
  }
  const { route } = await import("../scripts/ai-workflow-server.mjs");
  const distDir = resolve(projectRoot, "dist");
  const port = Number(process.env.AI_WORKFLOW_DESKTOP_PORT || 48973);

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/ai-workflow/")) {
      route(request, response);
      return;
    }

    let filePath = join(distDir, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(distDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(distDir, "index.html");
    }
    if (!existsSync(filePath)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("请先运行 npm run build 生成桌面版页面文件。");
      return;
    }
    response.writeHead(200, { "Content-Type": mimeType(filePath) });
    response.end(readFileSync(filePath));
  });

  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  return { server, url: `http://127.0.0.1:${port}/#/zh/projects/vibe-coding` };
}

let desktopServer;

async function createWindow() {
  const started = await startDesktopServer();
  desktopServer = started.server;

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 760,
    title: "AI直播间贴片生成项目",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await window.loadURL(started.url);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (desktopServer) desktopServer.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
