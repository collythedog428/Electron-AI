// Renderer. Two transports with the same interface:
//  - desktop window: window.claudeHub (preload bridge, IPC to the main process)
//  - localhost browser: fetch to /api/* with the per-launch token
// Chats and the display name are kept in localStorage (never the API key).
const $ = (id) => document.getElementById(id);
const modelSel = $("model");
const logEl = $("log");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const statusEl = $("status");

const desktopBackend = {
  status: () => window.claudeHub.status(),
  saveKey: (key) => window.claudeHub.saveKey(key),
  deleteKey: () => window.claudeHub.deleteKey(),
  setName: (name) => window.claudeHub.setName(name),
  models: (force) => window.claudeHub.models(force),
  localAccess: () => window.claudeHub.localAccess(),
  async chat(body, onEvent, signal) {
    const id = crypto.randomUUID();
    const off = window.claudeHub.onEvent((msg) => {
      if (msg.id === id) onEvent(msg);
    });
    const onAbort = () => window.claudeHub.cancel(id);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await window.claudeHub.chat(id, body);
    } finally {
      off();
      signal?.removeEventListener("abort", onAbort);
    }
  },
};

const TOKEN = document.querySelector('meta[name="app-token"]')?.content ?? "";

async function httpApi(path, { method = "GET", body, signal } = {}) {
  const headers = { "X-App-Token": TOKEN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const webBackend = {
  status: () => httpApi("/api/status"),
  saveKey: (apiKey) => httpApi("/api/key", { method: "POST", body: { apiKey } }),
  deleteKey: () => httpApi("/api/key", { method: "DELETE" }),
  setName: (name) => httpApi("/api/profile", { method: "POST", body: { name } }),
  models: (force) => httpApi(`/api/models${force ? "?refresh=1" : ""}`),
  localAccess: async () => ({ url: location.origin, error: null }),
  async chat(body, onEvent, signal) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "X-App-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) onEvent(JSON.parse(line.slice(6)));
      }
    }
  },
};

const backend = window.claudeHub ? desktopBackend : webBackend;

const KEYS = { chats: "electron.chats", active: "electron.activeChat", profile: "electron.profile", prefs: "electron.prefs" };

// ---------- appearance & behaviour preferences ----------
const ACCENTS = {
  violet: { label: "Violet", accent: "#7c5cff", accent2: "#d97757", light: "#a77cff" },
  ocean: { label: "Ocean", accent: "#2a9df4", accent2: "#34d399", light: "#67c3ff" },
  rose: { label: "Rose", accent: "#f43f5e", accent2: "#fb923c", light: "#ff7d94" },
  mint: { label: "Mint", accent: "#10b981", accent2: "#22d3ee", light: "#5ee0bb" },
  amber: { label: "Amber", accent: "#f59e0b", accent2: "#ef4444", light: "#ffc247" },
};
const DEFAULT_PREFS = {
  bg: "dots-glow", // dots-glow | dots | glow | plain
  dotSize: "22",
  dotStrength: 25, // 0-100
  accent: "violet",
  uiScale: "1",
  motion: "full", // system | full | reduced
  enterSends: true,
  confirmDelete: true,
  showMascot: true,
  speakReplies: true,
  outfit: { hat: "none", shirt: "violet", glasses: false },
};
const SHIRTS = {
  violet: { label: "Violet", color: "#7c5cff" },
  ocean: { label: "Ocean", color: "#2a9df4" },
  rose: { label: "Rose", color: "#f43f5e" },
  mint: { label: "Mint", color: "#10b981" },
  amber: { label: "Amber", color: "#f59e0b" },
  slate: { label: "Slate", color: "#475569" },
};
const DEFAULT_MODEL = "claude-haiku-5-5";
let prefs = loadPrefs();

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEYS.prefs)) || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs() {
  localStorage.setItem(KEYS.prefs, JSON.stringify(prefs));
}

function applyPrefs() {
  const root = document.documentElement;
  const style = root.style;
  const showDots = prefs.bg === "dots-glow" || prefs.bg === "dots";
  const showGlow = prefs.bg === "dots-glow" || prefs.bg === "glow";
  const accent = ACCENTS[prefs.accent] ?? ACCENTS.violet;

  style.setProperty("--dot-alpha", showDots ? String((prefs.dotStrength / 100) * 0.2) : "0");
  style.setProperty("--dot-size", `${prefs.dotSize}px`);
  style.setProperty("--glow-opacity", showGlow ? "1" : "0");
  style.setProperty("--ui-scale", prefs.uiScale);
  style.setProperty("--accent", accent.accent);
  style.setProperty("--accent-2", accent.accent2);
  style.setProperty("--accent-light", accent.light);
  root.dataset.motion = prefs.motion;
  $("mascot").hidden = !prefs.showMascot;
  const outfit = { ...DEFAULT_PREFS.outfit, ...(prefs.outfit || {}) };
  $("mascot").dataset.hat = outfit.hat;
  $("mascot").dataset.glasses = outfit.glasses ? "on" : "off";
  for (const id of ["outfit-preview", "voice-spark"]) {
    const el = $(id);
    if (!el) continue;
    el.dataset.hat = outfit.hat;
    el.dataset.glasses = outfit.glasses ? "on" : "off";
  }
  style.setProperty("--shirt", (SHIRTS[outfit.shirt] ?? SHIRTS.violet).color);

  input.placeholder = prefs.enterSends
    ? "Message Claude… (Enter to send, Shift+Enter for a new line)"
    : "Message Claude… (Ctrl+Enter to send, Enter for a new line)";
}

function renderSwatches() {
  const wrap = $("accent-swatches");
  wrap.replaceChildren();
  for (const [key, a] of Object.entries(ACCENTS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.title = a.label;
    b.setAttribute("aria-label", `${a.label} accent`);
    b.style.setProperty("--sw", a.accent);
    b.setAttribute("aria-pressed", String(prefs.accent === key));
    b.addEventListener("click", () => {
      prefs.accent = key;
      savePrefs();
      applyPrefs();
      renderSwatches();
    });
    wrap.append(b);
  }
}

function syncPrefControls() {
  $("bg-style").value = prefs.bg;
  $("dot-size").value = prefs.dotSize;
  $("dot-strength").value = prefs.dotStrength;
  $("ui-scale").value = prefs.uiScale;
  $("motion").value = prefs.motion;
  $("enter-sends").checked = prefs.enterSends;
  $("confirm-delete").checked = prefs.confirmDelete;
  $("show-mascot").checked = prefs.showMascot;
  $("speak-replies").checked = prefs.speakReplies;
  const outfit = { ...DEFAULT_PREFS.outfit, ...(prefs.outfit || {}) };
  $("spark-hat").value = outfit.hat;
  $("spark-glasses").checked = outfit.glasses;
  const wrap = $("shirt-swatches");
  wrap.replaceChildren();
  for (const [key, s] of Object.entries(SHIRTS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.title = s.label;
    b.setAttribute("aria-label", `${s.label} shirt`);
    b.style.setProperty("--sw", s.color);
    b.setAttribute("aria-pressed", String(outfit.shirt === key));
    b.addEventListener("click", () => setOutfit({ shirt: key }));
    wrap.append(b);
  }
  renderSwatches();
}

function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
  applyPrefs();
}
let controller = null;
let hasKey = false;
let chats = [];
let activeId = null;

// ---------- small helpers ----------
function flash(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function busyGuard() {
  if (controller) {
    flash("Wait for the reply or press Stop first.", true);
    return true;
  }
  return false;
}

function addMessage(role, text = "", attachments = []) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? (getName() || "You") : "Spark";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  wrap.append(label);
  if (attachments.length) {
    const row = document.createElement("div");
    row.className = "chip-row";
    row.append(...attachments.map((a) => attachmentChip(a.name, a.kind)));
    wrap.append(row);
  }
  wrap.append(body);
  logEl.append(wrap);
  logEl.scrollTop = logEl.scrollHeight;
  return { wrap, body };
}

function addThinking(wrap) {
  let details = wrap.querySelector("details.thinking");
  if (!details) {
    details = document.createElement("details");
    details.className = "thinking";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    const pre = document.createElement("pre");
    details.append(summary, pre);
    wrap.insertBefore(details, wrap.querySelector(".body"));
  }
  return details.querySelector("pre");
}

// ---------- profile (display name) ----------
// The name lives in the app's data folder, so the desktop window and localhost see the same one.
let profileName = "";
function getName() {
  return profileName;
}

function setName(name) {
  profileName = name;
  renderProfile();
  backend.setName(name).catch((err) => flash(err.message, true));
}

function renderProfile() {
  const name = getName();
  $("user-name").textContent = name || "Set your name";
  $("avatar").textContent = (name.trim()[0] || "?").toUpperCase();
  $("profile-name").value = name;
}

// ---------- chats ----------
function loadChats() {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS.chats));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function persist() {
  localStorage.setItem(KEYS.chats, JSON.stringify(chats));
  localStorage.setItem(KEYS.active, activeId ?? "");
}

function activeChat() {
  return chats.find((c) => c.id === activeId) ?? null;
}

function createChat() {
  const chat = { id: crypto.randomUUID(), title: "New chat", messages: [] };
  chats.unshift(chat);
  activeId = chat.id;
  persist();
  return chat;
}

function renderChatList() {
  const list = $("chat-list");
  list.replaceChildren();
  if (chats.length === 0) {
    const p = document.createElement("p");
    p.className = "chat-empty";
    p.textContent = "No chats yet. Start one with New chat.";
    list.append(p);
    return;
  }
  for (const c of chats) {
    const li = document.createElement("li");
    li.className = "chat-item" + (c.id === activeId ? " active" : "");
    li.dataset.id = c.id;
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = c.title;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.textContent = "×";
    del.title = "Delete chat";
    del.setAttribute("aria-label", `Delete chat ${c.title}`);
    li.append(title, del);
    list.append(li);
  }
}

function renderWelcome() {
  const name = getName();
  const div = document.createElement("div");
  div.className = "welcome";
  const h = document.createElement("h3");
  h.textContent = name ? `Hi ${name}, what's on your mind?` : "What's on your mind?";
  const p = document.createElement("p");
  p.textContent = "Pick a model in Settings, then start typing below.";
  div.append(h, p);
  logEl.append(div);
}

function renderMessages() {
  const chat = activeChat();
  $("chat-title").textContent = chat ? chat.title : "Chat";
  logEl.replaceChildren();
  if (!chat || chat.messages.length === 0) {
    renderWelcome();
  } else {
    for (const m of chat.messages) addMessage(m.role, m.content, m.attachments ?? []);
  }
}

function selectChat(id) {
  if (busyGuard()) return;
  activeId = id;
  persist();
  renderChatList();
  renderMessages();
  showView("chat");
}

// In-app confirmation. Resolves true for OK, false for Keep it or Escape.
function askConfirm({ title, message, confirmText = "OK", icon = "⚠️", danger = false }) {
  return new Promise((resolve) => {
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    $("confirm-icon").textContent = icon;
    const ok = $("confirm-ok");
    ok.textContent = confirmText;
    ok.classList.toggle("danger-solid", danger);
    const modal = $("confirm");
    const finish = (value) => {
      modal.hidden = true;
      ok.onclick = null;
      $("confirm-cancel").onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    ok.onclick = () => finish(true);
    $("confirm-cancel").onclick = () => finish(false);
    document.addEventListener("keydown", onKey);
    modal.hidden = false;
    $("confirm-cancel").focus(); // the safe choice is the default
  });
}

async function deleteChat(id) {
  if (busyGuard()) return;
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (prefs.confirmDelete) {
    const sure = await askConfirm({
      icon: "🗑️",
      title: `Delete "${chat.title}"?`,
      message: "This removes the whole conversation from this PC, including every message in it. It can't be undone.",
      confirmText: "Delete chat",
      danger: true,
    });
    if (!sure) return;
  }
  Mascot.set("sad", { text: "Bye, chat!", hold: 2500 });
  chats = chats.filter((c) => c.id !== id);
  if (activeId === id) activeId = chats[0]?.id ?? null;
  persist();
  renderChatList();
  renderMessages();
}

// ---------- status, models, key ----------
async function refreshStatus() {
  try {
    const s = await backend.status();
    hasKey = s.hasKey;
    profileName = s.name ?? "";
    renderProfile();
    let text = s.hasKey ? `Stored key: ${s.hint}` : "No key saved yet.";
    if (!s.storageAvailable) text += " Secure storage is unavailable on this system.";
    if (s.loadError) text += ` Could not unlock saved key (${s.loadError}).`;
    $("key-status").textContent = text;
    $("key-delete").hidden = !s.hasKey;
  } catch (err) {
    $("key-status").textContent = err.message;
  }
}

function updateBadge() {
  const opt = modelSel.selectedOptions[0];
  $("model-badge").textContent = opt ? opt.textContent : "No model";
}

async function loadModels(force = false) {
  $("model-info").textContent = "Loading models…";
  try {
    const data = await backend.models(force);
    const previous = modelSel.value || localStorage.getItem("model");
    modelSel.replaceChildren(
      ...data.models.map((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.display_name || m.id;
        return opt;
      }),
    );
    if (previous && data.models.some((m) => m.id === previous)) modelSel.value = previous;
    else if (data.models.some((m) => m.id === DEFAULT_MODEL)) modelSel.value = DEFAULT_MODEL;
    const note =
      data.source === "api"
        ? `${data.models.length} models from the Anthropic API.`
        : `Built-in list. ${data.error ?? ""}`.trim();
    $("model-info").textContent = note;
    updateBadge();
  } catch (err) {
    $("model-info").textContent = err.message;
  }
}

// ---------- file attachments ----------
const IMAGE_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXT = new Set(["txt", "md", "csv", "json", "js", "ts", "py", "html", "css", "xml", "yml", "yaml", "log"]);
const MAX_FILE_BYTES = { image: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, text: 500 * 1024 };
const LIMIT_LABEL = { image: "5 MB", pdf: "20 MB", text: "500 KB" };
const MAX_PENDING = 8;
let pending = []; // files chosen for the next message
const attachmentCache = new Map(); // id -> full file data, kept for this session so later turns can still use it

function fileKind(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (IMAGE_EXT[ext]) return { kind: "image", mediaType: IMAGE_EXT[ext] };
  if (ext === "pdf" || file.type === "application/pdf") return { kind: "pdf", mediaType: "application/pdf" };
  if (TEXT_EXT.has(ext) || file.type.startsWith("text/")) return { kind: "text", mediaType: "text/plain" };
  return null;
}

function readFileAs(file, asText) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    if (asText) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (pending.length >= MAX_PENDING) {
      flash(`You can attach up to ${MAX_PENDING} files to one message.`, true);
      break;
    }
    const info = fileKind(file);
    if (!info) {
      flash(`${file.name} is not a supported file type. Use images, PDFs or text files.`, true);
      continue;
    }
    if (file.size > MAX_FILE_BYTES[info.kind]) {
      flash(`${file.name} is over the ${LIMIT_LABEL[info.kind]} limit for ${info.kind === "text" ? "text" : info.kind + "s"}.`, true);
      continue;
    }
    const base = { id: crypto.randomUUID(), name: file.name, kind: info.kind, mediaType: info.mediaType, size: file.size };
    try {
      if (info.kind === "text") {
        pending.push({ ...base, text: await readFileAs(file, true) });
      } else {
        const url = await readFileAs(file, false); // data:<type>;base64,<data>
        pending.push({ ...base, data: url.slice(url.indexOf(",") + 1) });
      }
    } catch (err) {
      flash(err.message, true);
    }
  }
  if (pending.length) Mascot.set("happy", { text: "Got the file!", hold: 2500 });
  renderPending();
}

function attachmentChip(name, kind, onRemove) {
  const chip = document.createElement("span");
  chip.className = "chip";
  const icon = document.createElement("span");
  icon.className = "chip-icon";
  icon.textContent = kind === "image" ? "🖼️" : kind === "pdf" ? "📄" : "📝";
  const label = document.createElement("span");
  label.className = "chip-name";
  label.textContent = name;
  chip.append(icon, label);
  if (onRemove) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${name}`);
    x.addEventListener("click", onRemove);
    chip.append(x);
  }
  return chip;
}

function renderPending() {
  const wrap = $("attachments");
  wrap.replaceChildren(
    ...pending.map((f) =>
      attachmentChip(f.name, f.kind, () => {
        pending = pending.filter((p) => p.id !== f.id);
        renderPending();
      }),
    ),
  );
  wrap.hidden = pending.length === 0;
}

// Turns a stored message into the API shape. Files from earlier in the session are
// resent if they're still in memory; after a reload they're replaced by a short note.
function apiMessage(m) {
  if (!m.attachments?.length) return { role: m.role, content: m.content };
  const blocks = [];
  const missing = [];
  for (const a of m.attachments) {
    const f = attachmentCache.get(a.id);
    if (!f) {
      missing.push(a.name);
      continue;
    }
    if (f.kind === "text") {
      blocks.push({ type: "text", text: `File "${f.name}":\n\n${f.text}` });
    } else {
      blocks.push({
        type: f.kind === "image" ? "image" : "document",
        source: { type: "base64", media_type: f.mediaType, data: f.data },
      });
    }
  }
  let text = m.content || "";
  if (missing.length) text = `(Files from earlier in this chat are no longer available: ${missing.join(", ")}.)\n\n${text}`;
  if (text.trim()) blocks.push({ type: "text", text });
  return { role: m.role, content: blocks.length ? blocks : "(attachment)" };
}

// ---------- chatting ----------
function setBusy(busy) {
  sendBtn.disabled = busy;
  stopBtn.hidden = !busy;
  input.disabled = busy;
}

async function send() {
  const text = input.value.trim();
  if ((!text && pending.length === 0) || controller) return;
  if (!hasKey) return flash("Save an API key in Settings first.", true);
  if (!modelSel.value) return flash("Pick a model in Settings.", true);

  const chat = activeChat() ?? createChat();
  if (chat.messages.length === 0) logEl.replaceChildren();
  input.value = "";
  const files = pending;
  pending = [];
  renderPending();
  for (const f of files) attachmentCache.set(f.id, f);
  const fileRefs = files.map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size }));
  chat.messages.push({ role: "user", content: text, attachments: fileRefs });
  if (chat.messages.length === 1) {
    chat.title = (text || files[0]?.name || "").replace(/\s+/g, " ").slice(0, 40) || "New chat";
    $("chat-title").textContent = chat.title;
  }
  persist();
  renderChatList();
  addMessage("user", text, fileRefs);
  const assistant = addMessage("assistant");
  assistant.wrap.classList.add("streaming");

  controller = new AbortController();
  setBusy(true);
  flash("Streaming…");
  Mascot.set("thinking");
  if (voiceActive()) setVoiceStatus("Thinking…");
  let answer = "";
  let stopReason = null;
  let pre = null;
  let stopped = false;

  const failTurn = () => {
    chat.messages.pop(); // drop the unanswered user turn so history stays valid
    persist();
    if (files.length && pending.length === 0) {
      pending = files; // give the attachments back so the message can be sent again
      renderPending();
    }
  };

  try {
    await backend.chat(
      {
        model: modelSel.value,
        system: $("system").value,
        thinking: $("thinking").checked,
        effort: $("effort").value || undefined,
        messages: chat.messages.map(apiMessage),
      },
      (evt) => {
        if (evt.type === "text") {
          if (!answer) Mascot.set("typing", { line: false });
          answer += evt.text;
          assistant.body.textContent = answer;
          if (voiceActive()) $("voice-caption").textContent = answer;
          logEl.scrollTop = logEl.scrollHeight;
        } else if (evt.type === "thinking") {
          pre = pre ?? addThinking(assistant.wrap);
          pre.textContent += evt.text;
        } else if (evt.type === "done") {
          stopReason = evt.stop_reason;
        } else if (evt.type === "stopped") {
          stopped = true;
        } else if (evt.type === "error") {
          throw new Error(evt.message);
        }
      },
      controller.signal,
    );
  } catch (err) {
    assistant.wrap.classList.remove("streaming");
    if (err.name !== "AbortError") {
      if (answer === "") {
        failTurn();
        assistant.wrap.remove();
      }
      flash(err.message, true);
      Mascot.set("sad", { hold: 4000 });
      if (voiceActive()) setVoiceStatus("Something went wrong. Tap to try again.");
      controller = null;
      setBusy(false);
      return;
    }
    stopped = true;
  }

  assistant.wrap.classList.remove("streaming");
  if (answer) chat.messages.push({ role: "assistant", content: answer });
  else failTurn();
  persist();

  if (voiceActive()) {
    const spoken = answer || (stopReason === "refusal" ? "That one got declined." : "");
    $("voice-caption").textContent = spoken;
    if (answer && !stopped) speakReply(answer);
    else setVoiceStatus("Tap to talk");
  }
  if (stopReason === "refusal") Mascot.set("sad", { hold: 4000, text: "That one got declined." });
  else if (stopped) Mascot.set("idle", { line: false });
  else Mascot.set("happy", { hold: 3500 });
  if (stopReason === "refusal") flash("The model declined this request (refusal).", true);
  else if (stopReason === "max_tokens") flash("Stopped at the output limit.", true);
  else if (stopped) flash("Stopped.");
  else flash("");

  controller = null;
  setBusy(false);
  input.focus();
}

// ---------- first-run setup ----------
function needsSetup() {
  return !getName() || !hasKey;
}

// Shows a styled notice in the setup card and highlights the field at fault.
function setupError(message, isError = true, field = null) {
  const el = $("setup-status");
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle("error", isError);
  document.querySelectorAll(".setup-card input").forEach((i) => i.classList.remove("invalid"));
  if (field) $(field).classList.add("invalid");
}

function openSetup() {
  $("setup").hidden = false;
  $("setup-name").value = getName();
  $("setup-key").required = !hasKey;
  $("setup-key-hint").textContent = hasKey
    ? "A key is already saved. Paste a new one only to replace it."
    : "Stored encrypted on this PC. Create a key in the Anthropic Console.";
  (getName() ? $("setup-key") : $("setup-name")).focus();
}

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("setup-name").value.trim();
  const keyField = $("setup-key");
  const key = keyField.value.trim();
  keyField.value = "";
  if (!name) return setupError("Please enter your name so Claude knows what to call you.", true, "setup-name");
  if (!hasKey && !key) return setupError("Please paste your Anthropic API key to continue.", true, "setup-key");

  const submit = $("setup-submit");
  submit.disabled = true;
  setupError("Checking your key…", false);
  setName(name); // save the name straight away, so it's kept even if the key check fails
  try {
    if (key) await backend.saveKey(key);
    await refreshStatus();
    $("setup").hidden = true;
    Mascot.say(`Welcome, ${name}!`, "wave");
    await loadModels(true);
    renderMessages();
    flash(`Welcome, ${name}.`);
  } catch (err) {
    setupError(err.message, true, key ? "setup-key" : null);
  } finally {
    submit.disabled = false;
  }
});

// TEMP: testing only. Hides the setup screen without saving anything.
// Remove this handler and the #setup-skip button in index.html when testing is done.
$("setup-skip").addEventListener("click", () => {
  $("setup").hidden = true;
  flash("Setup skipped (testing mode). Nothing was saved.");
});

// ---------- chat export & import ----------
const EXPORT_FORMAT = "electron-chats";
const MAX_IMPORT_BYTES = 200 * 1024 * 1024; // ChatGPT exports can be large
const MAX_IMPORT_CHATS = 5000;
const MAX_IMPORT_MESSAGES = 2000;

function chatDataStatus(message, isError = false) {
  const el = $("chat-data-status");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function exportChats() {
  if (busyGuard()) return;
  if (chats.length === 0) return chatDataStatus("There are no chats to export yet.", true);
  const payload = {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    chats: chats.map((c) => ({
      id: c.id,
      title: c.title,
      messages: c.messages.map((m) => ({ role: m.role, content: m.content })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `electron-chats-${date}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  chatDataStatus(`Exported ${chats.length} chat${chats.length === 1 ? "" : "s"}.`);
}

// Accepts only the shape this app writes. Anything else is skipped, not trusted.
function sanitiseImportedChat(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.messages)) return null;
  const messages = [];
  for (const m of raw.messages.slice(0, MAX_IMPORT_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" || !m.content.trim()) return null;
    messages.push({ role: m.role, content: m.content });
  }
  if (messages.length && messages[0].role !== "user") return null;
  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.replace(/\s+/g, " ").trim().slice(0, 80)
      : messages[0]?.content.replace(/\s+/g, " ").slice(0, 40) || "Imported chat";
  return { id: crypto.randomUUID(), title, messages };
}

// Reads one chat export (JSON) and returns its list of chats. Throws a readable error otherwise.
function chatListFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON, so nothing was imported.");
  }
  // ChatGPT and Claude exports are arrays of conversations; convert them to our shape.
  if (Array.isArray(data) && data.some(isForeignConversation)) {
    return data.filter(isForeignConversation).map(normaliseForeignConversation).filter(Boolean);
  }
  const list = Array.isArray(data) ? data : data?.format === EXPORT_FORMAT ? data.chats : null;
  if (!Array.isArray(list)) throw new Error("That file is not a chat export this app recognises (Electron, ChatGPT or Claude).");
  return list;
}

// Accepts a single .json export, or a .zip containing one or more of them.
async function readChatLists(file) {
  const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
  if (!isZip) return chatListFromJson(await file.text());
  if (file.size > ZIP_MAX_BYTES) throw new Error("That zip is too large to import (200 MB limit).");
  const entries = await readZipJsonFiles(new Uint8Array(await file.arrayBuffer()));
  if (entries.length === 0) throw new Error("No chat .json files were found in that zip.");
  const lists = [];
  for (const entry of entries) {
    try {
      lists.push(...chatListFromJson(entry.text));
    } catch {
      // A bad file inside the zip is skipped; the others still import.
    }
  }
  if (lists.length === 0) throw new Error("None of the .json files in that zip are chat exports.");
  return lists;
}

async function importChats(file) {
  if (busyGuard()) return;
  if (!file) return;
  const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
  if (!isZip && file.size > MAX_IMPORT_BYTES) return chatDataStatus("That file is too large to import (200 MB limit).", true);
  let list;
  try {
    list = await readChatLists(file);
  } catch (err) {
    return chatDataStatus(err.message, true);
  }
  const imported = list.slice(0, MAX_IMPORT_CHATS).map(sanitiseImportedChat).filter(Boolean);
  const skipped = list.length - imported.length;
  if (imported.length === 0) return chatDataStatus("No valid chats were found in that file.", true);

  chats = [...imported, ...chats];
  Mascot.set("happy", { text: "Chats imported!", hold: 3000 });
  persist();
  renderChatList();
  renderMessages();
  chatDataStatus(
    `Imported ${imported.length} chat${imported.length === 1 ? "" : "s"}` +
      (skipped ? ` (${skipped} invalid entr${skipped === 1 ? "y" : "ies"} skipped).` : "."),
  );
}

// ---------- speech to text (desktop app only) ----------
const MAX_RECORDING_MS = 3 * 60 * 1000;
const speechAvailable = Boolean(window.claudeHub?.speechStatus);
let recorder = null;
let recordingStream = null;
let recordTimer = null;
let transcribing = false;

async function refreshSpeech() {
  if (!speechAvailable) {
    $("speech-status").textContent = "Speech to text is available in the desktop app.";
    return;
  }
  try {
    const s = await window.claudeHub.speechStatus();
    $("mic").hidden = !s.supported;
    $("speech-status").textContent = s.ready
      ? "Ready. Click 🎙️ in the chat box to dictate."
      : "Not installed yet. Download the speech model below.";
    $("speech-install").hidden = s.ready;
  } catch (err) {
    $("speech-status").textContent = err.message;
  }
}

// Whisper expects 16 kHz mono 16-bit WAV. Convert the recorded audio to that.
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

async function toWav16k(arrayBuffer) {
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }
  const length = Math.ceil(decoded.duration * 16000);
  if (!length) throw new Error("No audio was captured.");
  const offline = new OfflineAudioContext(1, length, 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), 16000);
}

async function finishRecording(chunks, mime) {
  const mic = $("mic");
  mic.classList.remove("recording");
  mic.textContent = "🎙️";
  transcribing = true;
  mic.disabled = true;
  Mascot.set("thinking", { text: "Listening back…" });
  setVoiceStatus("Transcribing…");
  flash("Transcribing…");
  try {
    if (chunks.length === 0) throw new Error("No audio was captured.");
    const blob = new Blob(chunks, { type: mime || "audio/webm" });
    const wav = await toWav16k(await blob.arrayBuffer());
    const text = await window.claudeHub.speechTranscribe(wav);
    if (!text) return flash("No speech was detected.", true);
    input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
    input.focus();
    Mascot.set("happy", { text: "Got your words!", hold: 3000 });
    if (voiceRequested) {
      voiceRequested = false;
      await send(); // voice requests are sent straight away
    } else {
      flash("Transcribed. Check the text, then send.");
    }
  } catch (err) {
    flash(err.message, true);
    Mascot.set("sad", { hold: 3500 });
    voiceRequested = false;
  } finally {
    transcribing = false;
    mic.disabled = false;
    if (!controller) setVoiceStatus("Tap to talk");
  }
}

function stopRecording() {
  clearTimeout(recordTimer);
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recordingStream?.getTracks().forEach((t) => t.stop());
  recorder = null;
  recordingStream = null;
}

async function toggleMic() {
  if (recorder) return stopRecording();
  if (transcribing) return flash("Still transcribing the last recording.", true);
  if (controller) return flash("Wait for the reply or press Stop first.", true);
  const s = await window.claudeHub.speechStatus();
  if (!s.ready) return flash("Download the speech model in Settings first.", true);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return flash("Microphone access was blocked. Allow it in Windows privacy settings.", true);
  }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  const mime = rec.mimeType;
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.onstop = () => finishRecording(chunks, mime);
  recorder = rec;
  recordingStream = stream;
  rec.start();
  $("mic").classList.add("recording");
  Mascot.set("listening", { hold: 0 });
  setVoiceStatus("Listening… tap to stop", true);
  $("mic").textContent = "⏹";
  flash("Listening… click ⏹ when you're done.");
  recordTimer = setTimeout(stopRecording, MAX_RECORDING_MS);
}

$("mic").addEventListener("click", toggleMic);
$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = ""; // allow picking the same file again
  await addFiles(files);
});
if (speechAvailable) {
  window.claudeHub.onSpeechProgress((p) => {
    const label = p.stage === "engine" ? "Downloading speech engine" : p.stage === "model" ? "Downloading speech model" : "Finishing";
    $("speech-progress").textContent = `${label}… ${p.percent}%`;
  });
}
$("speech-install").addEventListener("click", async () => {
  const btn = $("speech-install");
  btn.disabled = true;
  try {
    await window.claudeHub.speechInstall();
    $("speech-progress").textContent = "Speech model installed.";
  } catch (err) {
    $("speech-progress").textContent = err.message;
  } finally {
    btn.disabled = false;
    await refreshSpeech();
  }
});

// ---------- voice console ----------
let voiceRequested = false; // the next transcription should be sent straight away
const voiceActive = () => $("view-voice").classList.contains("active");

function setVoiceStatus(text, listening = false) {
  $("voice-status").textContent = text;
  // Drives the reactor ring: listening, busy (thinking or transcribing), speaking or idle.
  const state = listening ? "listening" : /^(Thinking|Transcribing)/.test(text) ? "busy" : /^Speaking/.test(text) ? "speaking" : "idle";
  document.querySelector(".voice-console").dataset.state = state;
  $("voice-talk").classList.toggle("listening", listening);
  $("voice-talk").textContent = listening ? "⏹ Stop" : "🎙️ Tap to talk";
}

function speakReply(text) {
  if (!("speechSynthesis" in window) || !prefs.speakReplies || !text.trim()) {
    setVoiceStatus("Tap to talk");
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 3000));
  utterance.onstart = () => {
    setVoiceStatus("Speaking… tap to stop");
    Mascot.set("typing");
  };
  utterance.onend = utterance.onerror = () => {
    setVoiceStatus("Tap to talk");
    Mascot.set("idle");
  };
  speechSynthesis.speak(utterance);
}

$("voice-talk").addEventListener("click", async () => {
  if (window.speechSynthesis?.speaking) {
    speechSynthesis.cancel();
    setVoiceStatus("Tap to talk");
    Mascot.set("idle");
    return;
  }
  if (recorder) return stopRecording();
  if (!speechAvailable) return setVoiceStatus("Voice needs the desktop app.");
  if (controller) return setVoiceStatus("Still answering. Tap to talk again soon.");
  const s = await window.claudeHub.speechStatus();
  if (!s.ready) return setVoiceStatus("Download the speech model in Settings first.");
  voiceRequested = true;
  toggleMic();
});

document.querySelectorAll(".mode-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.mode)));

// ---------- navigation ----------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("open-settings").classList.toggle("active", name === "settings");
  // The sidebar folds to an icon strip in Voice mode, so the console has room.
  document.querySelector(".app").classList.toggle("sidebar-collapsed", name === "voice");
  document.querySelectorAll(".mode-btn").forEach((b) => {
    const on = b.dataset.mode === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  if (name === "chat") input.focus();
}

// ---------- wiring ----------
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const sends = prefs.enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey;
  if (sends) {
    e.preventDefault();
    send();
  }
});

// Appearance & behaviour controls
$("bg-style").addEventListener("change", (e) => setPref("bg", e.target.value));
$("dot-size").addEventListener("change", (e) => setPref("dotSize", e.target.value));
$("dot-strength").addEventListener("input", (e) => setPref("dotStrength", Number(e.target.value)));
$("ui-scale").addEventListener("change", (e) => setPref("uiScale", e.target.value));
$("motion").addEventListener("change", (e) => setPref("motion", e.target.value));
$("enter-sends").addEventListener("change", (e) => setPref("enterSends", e.target.checked));
$("confirm-delete").addEventListener("change", (e) => setPref("confirmDelete", e.target.checked));
$("show-mascot").addEventListener("change", (e) => setPref("showMascot", e.target.checked));
$("speak-replies").addEventListener("change", (e) => setPref("speakReplies", e.target.checked));
$("spark-hat").addEventListener("change", (e) => setOutfit({ hat: e.target.value }));
$("spark-glasses").addEventListener("change", (e) => setOutfit({ glasses: e.target.checked }));
function setOutfit(changes) {
  prefs.outfit = { ...DEFAULT_PREFS.outfit, ...(prefs.outfit || {}), ...changes };
  savePrefs();
  applyPrefs();
  syncPrefControls();
  // Show off the new look in the preview.
  const preview = $("outfit-preview");
  if (preview) {
    preview.dataset.mood = "bounce";
    clearTimeout(setOutfit.timer);
    setOutfit.timer = setTimeout(() => (preview.dataset.mood = "idle"), 1500);
  }
}
$("reset-prefs").addEventListener("click", () => {
  prefs = { ...DEFAULT_PREFS };
  savePrefs();
  applyPrefs();
  syncPrefControls();
  flash("Appearance and behaviour reset to defaults.");
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
stopBtn.addEventListener("click", () => controller?.abort());

$("new-chat").addEventListener("click", () => {
  if (busyGuard()) return;
  Mascot.set("excited", { hold: 3000 });
  const current = activeChat();
  if (!current || current.messages.length > 0) createChat();
  renderChatList();
  renderMessages();
  showView("chat");
});

$("chat-list").addEventListener("click", (e) => {
  const li = e.target.closest(".chat-item");
  if (!li) return;
  if (e.target.closest(".chat-del")) deleteChat(li.dataset.id);
  else selectChat(li.dataset.id);
});

$("open-settings").addEventListener("click", () => showView("settings"));

$("export-chats").addEventListener("click", exportChats);
$("import-chats").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow importing the same file again later
  await importChats(file);
});

$("clear").addEventListener("click", () => {
  if (busyGuard()) return;
  const chat = activeChat();
  if (!chat) return;
  chat.messages = [];
  chat.title = "New chat";
  persist();
  renderChatList();
  renderMessages();
  flash("");
});

$("profile-name").addEventListener("change", (e) => {
  const name = e.target.value.trim();
  if (name) setName(name);
  else e.target.value = getName();
});

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const field = $("key-input");
  const key = field.value.trim();
  field.value = "";
  flash("Verifying key…");
  try {
    await backend.saveKey(key);
    await refreshStatus();
    await loadModels(true);
    flash("Key verified and saved.");
  } catch (err) {
    flash(err.message, true);
  }
});

$("key-delete").addEventListener("click", async () => {
  const sure = await askConfirm({
    icon: "🔑",
    title: "Remove your API key?",
    message: "The key is deleted from this computer. You'll need to paste it again to chat.",
    confirmText: "Remove key",
    danger: true,
  });
  if (!sure) return;
  try {
    await backend.deleteKey();
    await refreshStatus();
    await loadModels(true);
    flash("Key removed.");
  } catch (err) {
    flash(err.message, true);
  }
});

$("refresh-models").addEventListener("click", () => loadModels(true));
modelSel.addEventListener("change", () => {
  localStorage.setItem("model", modelSel.value);
  updateBadge();
});

$("thinking").checked = localStorage.getItem("thinking") === "1";
$("thinking").addEventListener("change", (e) => localStorage.setItem("thinking", e.target.checked ? "1" : "0"));
$("effort").value = localStorage.getItem("effort") || "";
$("effort").addEventListener("change", (e) => localStorage.setItem("effort", e.target.value));

// ---------- boot ----------
(async () => {
  // Copy Spark's drawing into the Voice console (its own gradient id, as with the preview).
  const voiceSparkEl = $("voice-spark");
  if (voiceSparkEl) voiceSparkEl.innerHTML = $("mascot").querySelector("svg").outerHTML.replaceAll("mascot-body", "voice-body");
  // Copy Spark's drawing into the Settings preview.
  const previewEl = $("outfit-preview");
  if (previewEl) {
    // Own gradient id: the chat header's copy is hidden while Settings is open, and hidden gradients don't draw.
    previewEl.innerHTML = $("mascot").querySelector("svg").outerHTML.replaceAll("mascot-body", "preview-body");
    // Give the preview headroom so hats above the head aren't cut off.
    previewEl.querySelector("svg").setAttribute("viewBox", "-14 -18 148 188");
  }
  applyPrefs();
  syncPrefControls();
  renderProfile();
  chats = loadChats();
  activeId = localStorage.getItem(KEYS.active) || null;
  if (!chats.some((c) => c.id === activeId)) activeId = chats[0]?.id ?? null;
  renderChatList();
  renderMessages();

  await refreshStatus();
  // One-time move: a name saved by an older version in this browser's storage goes to the app.
  let legacyName = "";
  try {
    legacyName = (JSON.parse(localStorage.getItem(KEYS.profile)) || {}).name || "";
  } catch {
    legacyName = "";
  }
  if (!getName() && legacyName) setName(legacyName);
  await refreshSpeech();
  if (needsSetup()) openSetup();
  else Mascot.say(getName() ? `Hi ${getName()}!` : "Hi there!", "wave");
  await loadModels();

  try {
    const access = await backend.localAccess();
    if (window.claudeHub) {
      $("local-access").textContent = access.url
        ? `Also open in a browser on this PC: ${access.url}`
        : access.error;
    } else {
      $("local-access").textContent = "Running in browser mode.";
    }
  } catch {
    $("local-access").textContent = "";
  }
})();
