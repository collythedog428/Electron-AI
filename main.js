// Electron main process: owns the API key, talks to Anthropic, and opens the window.
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, HttpError } from "./lib/hub.js";
import { KeyStore } from "./lib/key-store.js";
import { startLocalServer } from "./lib/local-server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const LOCAL_PORT = Number(process.env.CLAUDE_HUB_PORT) || 4317;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const hub = new Hub({
  keyStore: new KeyStore({
    file: path.join(app.getPath("userData"), "api-key.bin"),
    crypto: safeStorage,
  }),
});

const controllers = new Map(); // requestId -> AbortController
let localAccess = { url: null, error: "Local browser access is disabled." };

function isOurWindow(event) {
  // Only accept IPC from pages we loaded ourselves (file:// app shell).
  return typeof event.senderFrame?.url === "string" && event.senderFrame.url.startsWith("file:");
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isOurWindow(event)) return { ok: false, error: "Blocked." };
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(`${channel} failed:`, err?.message);
      return { ok: false, error: err instanceof HttpError ? err.message : "Unexpected error." };
    }
  });
}

handle("hub:status", () => hub.status());
handle("hub:saveKey", (_e, apiKey) => hub.saveKey(apiKey));
handle("hub:deleteKey", () => hub.deleteKey());
handle("hub:models", (_e, force) => hub.models(force === true));
handle("app:localAccess", () => localAccess);

handle("hub:chat", async (event, id, body) => {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw new HttpError(400, "Invalid request id.");
  }
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    await hub.chat(
      body,
      (evt) => {
        if (!event.sender.isDestroyed()) event.sender.send("hub:event", { id, ...evt });
      },
      controller.signal,
    );
    return { done: true };
  } finally {
    controllers.delete(id);
  }
});

ipcMain.on("hub:cancel", (event, id) => {
  if (isOurWindow(event)) controllers.get(id)?.abort();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    title: "Electron",
    backgroundColor: "#15171c",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadFile(path.join(PUBLIC_DIR, "index.html"));
}

app.whenReady().then(async () => {
  await hub.init();
  if (process.env.CLAUDE_HUB_LOCAL !== "0") {
    try {
      const server = await startLocalServer({ hub, publicDir: PUBLIC_DIR, port: LOCAL_PORT });
      localAccess = { url: server.url, error: null };
    } catch (err) {
      localAccess = { url: null, error: `Could not open port ${LOCAL_PORT}: ${err.message}` };
    }
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
