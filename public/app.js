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

function addMessage(role, text = "") {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? (getName() || "You") : "Claude";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  wrap.append(label, body);
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
function getName() {
  try {
    return (JSON.parse(localStorage.getItem(KEYS.profile)) || {}).name || "";
  } catch {
    return "";
  }
}

function setName(name) {
  localStorage.setItem(KEYS.profile, JSON.stringify({ name }));
  renderProfile();
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
    for (const m of chat.messages) addMessage(m.role, m.content);
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

function deleteChat(id) {
  if (busyGuard()) return;
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (prefs.confirmDelete && !confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
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

// ---------- chatting ----------
function setBusy(busy) {
  sendBtn.disabled = busy;
  stopBtn.hidden = !busy;
  input.disabled = busy;
}

async function send() {
  const text = input.value.trim();
  if (!text || controller) return;
  if (!hasKey) return flash("Save an API key in Settings first.", true);
  if (!modelSel.value) return flash("Pick a model in Settings.", true);

  const chat = activeChat() ?? createChat();
  if (chat.messages.length === 0) logEl.replaceChildren();
  input.value = "";
  chat.messages.push({ role: "user", content: text });
  if (chat.messages.length === 1) {
    chat.title = text.replace(/\s+/g, " ").slice(0, 40) || "New chat";
    $("chat-title").textContent = chat.title;
  }
  persist();
  renderChatList();
  addMessage("user", text);
  const assistant = addMessage("assistant");
  assistant.wrap.classList.add("streaming");

  controller = new AbortController();
  setBusy(true);
  flash("Streaming…");
  let answer = "";
  let stopReason = null;
  let pre = null;
  let stopped = false;

  const failTurn = () => {
    chat.messages.pop(); // drop the unanswered user turn so history stays valid
    persist();
  };

  try {
    await backend.chat(
      {
        model: modelSel.value,
        system: $("system").value,
        thinking: $("thinking").checked,
        effort: $("effort").value || undefined,
        messages: chat.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      (evt) => {
        if (evt.type === "text") {
          answer += evt.text;
          assistant.body.textContent = answer;
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
  try {
    if (key) await backend.saveKey(key);
    await refreshStatus();
    setName(name);
    $("setup").hidden = true;
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

// ---------- navigation ----------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("open-settings").classList.toggle("active", name === "settings");
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
  if (!confirm("Remove the stored API key from this computer?")) return;
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
  applyPrefs();
  syncPrefControls();
  renderProfile();
  chats = loadChats();
  activeId = localStorage.getItem(KEYS.active) || null;
  if (!chats.some((c) => c.id === activeId)) activeId = chats[0]?.id ?? null;
  renderChatList();
  renderMessages();

  await refreshStatus();
  if (needsSetup()) openSetup();
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
