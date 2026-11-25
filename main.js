// Electron main process: owns the API key, talks to Anthropic, and opens the window.
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, HttpError } from "./lib/hub.js";
import { KeyStore } from "./lib/key-store.js";
import { startLocalServer } from "./lib/local-server.js";
import { SpeechService } from "./lib/speech.js";
import { createToolExecutor } from "./lib/computer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const LOCAL_PORT = Number(process.env.CLAUDE_HUB_PORT) || 4317;

// One fixed data folder for every run (dev `electron .` and the packaged .exe),
// so the saved key, name and chats are always found again.
app.setPath("userData", path.join(app.getPath("appData"), "Electron"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const hub = new Hub({
  keyStore: new KeyStore({
    file: path.join(app.getPath("userData"), "api-key.bin"),
    crypto: safeStorage,
  }),
  profileFile: path.join(app.getPath("userData"), "profile.json"),
  // Spark's tools (files, screen, mouse and keyboard). Only the desktop window gets these.
  computer: { execute: createToolExecutor({ captureScreen }) },
});

async function captureScreen() {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } });
  if (!sources.length) throw new Error("No screen was found.");
  return sources[0].thumbnail.toPNG();
}

const speech = new SpeechService({ dir: path.join(app.getPath("userData"), "whisper") });

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
handle("hub:setName", (_e, name) => hub.setName(name));
handle("hub:approve", (_e, id, allow) => hub.approve(id, allow));
handle("hub:models", (_e, force) => hub.models(force === true));
handle("app:localAccess", () => localAccess);

handle("speech:status", () => speech.status());
handle("speech:install", async (event) => {
  return speech.install((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send("speech:progress", progress);
  });
});
handle("speech:transcribe", (_e, bytes) => {
  if (!(bytes instanceof Uint8Array)) throw new HttpError(400, "No audio was received.");
  return speech.transcribe(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
});

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
