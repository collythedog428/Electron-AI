// Renderer. Two transports with the same interface:
//  - desktop window: window.claudeHub (preload bridge, IPC to the main process)
//  - localhost browser: fetch to /api/* with the per-launch token
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

const history = []; // {role, content} - text only; thinking is never replayed
let controller = null;
let hasKey = false;

function flash(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function addMessage(role, text = "") {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? "You" : "Claude";
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
    else if (data.models.some((m) => m.id === "claude-opus-5-5")) modelSel.value = "claude-opus-5-5";
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

function setBusy(busy) {
  sendBtn.disabled = busy;
  stopBtn.hidden = !busy;
  input.disabled = busy;
}

async function send() {
  const text = input.value.trim();
  if (!text || controller) return;
  if (!hasKey) return flash("Save an API key first.", true);
  if (!modelSel.value) return flash("Pick a model.", true);

  input.value = "";
  history.push({ role: "user", content: text });
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

  try {
    await backend.chat(
      {
        model: modelSel.value,
        system: $("system").value,
        thinking: $("thinking").checked,
        effort: $("effort").value || undefined,
        messages: history,
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
      // Remove the unanswered user turn so the conversation stays valid.
      if (answer === "") {
        history.pop();
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
  if (answer) history.push({ role: "assistant", content: answer });
  else history.pop();

  if (stopReason === "refusal") flash("The model declined this request (refusal).", true);
  else if (stopReason === "max_tokens") flash("Stopped at the output limit.", true);
  else if (stopped) flash("Stopped.");
  else flash("");

  controller = null;
  setBusy(false);
  input.focus();
}

// ---- wiring ----
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
stopBtn.addEventListener("click", () => controller?.abort());

$("clear").addEventListener("click", () => {
  if (controller) return;
  history.length = 0;
  logEl.replaceChildren();
  flash("");
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

// ---- navigation between Chat and Settings ----
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (name === "chat") input.focus();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function updateBadge() {
  const opt = modelSel.selectedOptions[0];
  $("model-badge").textContent = opt ? opt.textContent : "No model";
}

$("thinking").checked = localStorage.getItem("thinking") === "1";
$("thinking").addEventListener("change", (e) => localStorage.setItem("thinking", e.target.checked ? "1" : "0"));
$("effort").value = localStorage.getItem("effort") || "";
$("effort").addEventListener("change", (e) => localStorage.setItem("effort", e.target.value));

(async () => {
  await refreshStatus();
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
