// Core logic shared by the desktop window (IPC) and the optional localhost server.
// Nothing in here returns or emits the API key.
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchModels, FALLBACK_MODELS } from "./models.js";
import { runWithTools, createApprovals } from "./agent.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{3,80}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Models that take a manual thinking budget instead of adaptive thinking.
const LEGACY_RE = /^claude-(haiku|sonnet|opus)-4-5/;
const MAX_MESSAGES = 200;
const MAX_CHAT_CHARS = 800_000;
const MODEL_TTL_MS = 10 * 60 * 1000;

// Only true/false values are accepted for each power. Anything else counts as off.
export function sanitisePowers(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    files_read: p.files_read === true,
    files_write: p.files_write === true,
    screen: p.screen === true,
    control: p.control === true,
    askFirst: p.askFirst !== false, // asking first is the default
  };
}

export function hintFor(key) {
  return `sk-ant-…${key.slice(-4)}`;
}

export function describeError(err) {
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    if (s === 401) return "Anthropic rejected the API key.";
    if (s === 403) return "This key does not have permission for that request.";
    if (s === 404) return "Model not found or not available to this key.";
    if (s === 429) return "Rate limited. Wait a moment and try again.";
    return `API error ${s ?? ""}: ${err.message}`.trim();
  }
  return "Request failed.";
}

// Attachments: images, PDFs and text. Only these block types are accepted from the client.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BLOCK_CHARS = 500_000;
const MAX_FILE_BYTES_PER_REQUEST = 24 * 1024 * 1024; // stays under the 32 MB request limit
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodedSize(b64) {
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

function checkBlock(block, msgIndex) {
  const bad = () => new HttpError(400, `Unsupported attachment in message ${msgIndex}.`);
  if (!block || typeof block !== "object") throw bad();
  if (block.type === "text") {
    if (typeof block.text !== "string" || !block.text.trim() || block.text.length > MAX_TEXT_BLOCK_CHARS) throw bad();
    return { kind: "text", text: block.text, block: { type: "text", text: block.text } };
  }
  if (block.type === "image" || block.type === "document") {
    const src = block.source;
    if (!src || src.type !== "base64" || typeof src.data !== "string") throw bad();
    if (!BASE64_RE.test(src.data)) throw bad();
    const bytes = decodedSize(src.data);
    if (block.type === "image") {
      if (!IMAGE_TYPES.has(src.media_type) || bytes > MAX_IMAGE_BYTES) {
        throw new HttpError(400, "Images must be PNG, JPEG, GIF or WebP and under 5 MB.");
      }
      return {
        kind: "file",
        bytes,
        block: { type: "image", source: { type: "base64", media_type: src.media_type, data: src.data } },
      };
    }
    if (src.media_type !== "application/pdf" || bytes > MAX_PDF_BYTES) {
      throw new HttpError(400, "PDF attachments must be under 20 MB.");
    }
    return {
      kind: "file",
      bytes,
      block: { type: "document", source: { type: "base64", media_type: "application/pdf", data: src.data } },
    };
  }
  throw bad();
}

function buildParams(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid request.");
  if (typeof body.model !== "string" || !MODEL_RE.test(body.model)) {
    throw new HttpError(400, "Invalid model id.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    throw new HttpError(400, `Conversation must have 1-${MAX_MESSAGES} messages.`);
  }
  let total = 0;
  let fileBytes = 0;
  const messages = body.messages.map((m, i) => {
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      throw new HttpError(400, `Invalid message at index ${i}.`);
    }
    if (typeof m.content === "string" && m.content.trim()) {
      total += m.content.length;
      return { role: m.role, content: m.content };
    }
    if (Array.isArray(m.content) && m.content.length > 0) {
      const blocks = m.content.map((block) => {
        const checked = checkBlock(block, i);
        if (checked.kind === "text") total += checked.text.length;
        else fileBytes += checked.bytes;
        return checked.block;
      });
      return { role: m.role, content: blocks };
    }
    throw new HttpError(400, `Invalid message at index ${i}.`);
  });
  if (total > MAX_CHAT_CHARS) {
    throw new HttpError(413, "Conversation is too long. Clear it or start a new chat.");
  }
  if (fileBytes > MAX_FILE_BYTES_PER_REQUEST) {
    throw new HttpError(413, "Attached files are too large for one message. Attach fewer or smaller files.");
  }
  if (messages[0].role !== "user" || messages.at(-1).role !== "user") {
    throw new HttpError(400, "Conversation must start and end with a user message.");
  }

  const params = { model: body.model, max_tokens: 32000, messages };
  if (typeof body.system === "string" && body.system.trim()) {
    params.system = body.system.slice(0, 20_000);
  }
  const legacy = LEGACY_RE.test(body.model);
  if (!legacy && body.thinking === true) {
    params.thinking = { type: "adaptive", display: "summarized" };
  }
  if (!legacy && EFFORTS.has(body.effort)) {
    params.output_config = { effort: body.effort };
  }
  return params;
}

export class Hub {
  /**
   * @param {object} opts
   * @param {import("./key-store.js").KeyStore} opts.keyStore
   * @param {(apiKey: string) => Anthropic} [opts.clientFactory]
   */
  constructor({ keyStore, clientFactory, profileFile = null, computer = null }) {
    this.keyStore = keyStore;
    this.clientFactory =
      clientFactory ?? ((apiKey) => new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 }));
    this.apiKey = null; // held only in main-process memory
    this.hint = null;
    this.modelCache = null;
    this.loadError = null;
    this.profileFile = profileFile; // where the display name is saved (not secret)
    this.computer = computer; // { execute } for Spark's tools; null disables them (web view)
    this.approvals = createApprovals();
    this.name = "";
  }

  async init() {
    try {
      const key = await this.keyStore.load();
      if (key) this._setKey(key);
    } catch (err) {
      this.loadError = err.message;
    }
    if (this.profileFile) {
      try {
        const saved = JSON.parse(await readFile(this.profileFile, "utf8"));
        if (typeof saved.name === "string") this.name = saved.name.slice(0, 40);
      } catch {
        // no profile saved yet
      }
    }
  }

  async setName(raw) {
    const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 40) throw new HttpError(400, "Please enter a name of 1 to 40 characters.");
    this.name = name;
    if (this.profileFile) {
      await mkdir(path.dirname(this.profileFile), { recursive: true });
      const tmp = `${this.profileFile}.tmp`;
      await writeFile(tmp, JSON.stringify({ name }), "utf8");
      await rename(tmp, this.profileFile);
    }
    return { ok: true, name };
  }

  _setKey(key) {
    this.apiKey = key;
    this.hint = hintFor(key);
    this.modelCache = null;
  }

  status() {
    return {
      name: this.name,
      hasKey: Boolean(this.apiKey),
      hint: this.hint,
      storageAvailable: this.keyStore.available(),
      loadError: this.loadError,
    };
  }

  async saveKey(raw) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key.length > 300 || !KEY_RE.test(key)) {
      throw new HttpError(400, "That does not look like a Claude API key (it should start with sk-ant-).");
    }
    if (key.startsWith("sk-ant-admin")) {
      throw new HttpError(400, "Admin keys are not accepted here. Use a standard API key.");
    }
    try {
      await fetchModels(this.clientFactory(key)); // verify before storing
    } catch (err) {
      throw new HttpError(400, `Key check failed: ${describeError(err)}`);
    }
    await this.keyStore.save(key);
    this._setKey(key);
    return { ok: true, hint: this.hint };
  }

  async deleteKey() {
    await this.keyStore.delete();
    this.apiKey = null;
    this.hint = null;
    this.modelCache = null;
    return { ok: true };
  }

  async models(force = false) {
    if (!this.apiKey) {
      return { source: "builtin", models: FALLBACK_MODELS, error: "No API key saved." };
    }
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_TTL_MS) {
      return this.modelCache.value;
    }
    try {
      const value = { source: "api", models: await fetchModels(this.clientFactory(this.apiKey)) };
      this.modelCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      return { source: "builtin", models: FALLBACK_MODELS, error: describeError(err) };
    }
  }

  /**
   * Streams a reply. `emit` receives {type: text|thinking|done|error|stopped, ...}.
   * Validation problems throw HttpError before anything is emitted.
   */
  // Answers an approval card in the chat. Returns false if that request is no longer waiting.
  approve(id, allow) {
    if (typeof id !== "string" || id.length > 80) throw new HttpError(400, "Invalid approval id.");
    return this.approvals.answer(id, allow === true);
  }

  async chat(body, emit, signal) {
    if (!this.apiKey) throw new HttpError(400, "No API key saved. Add one first.");
    const params = buildParams(body);
    const powers = sanitisePowers(body.powers);
    if (this.computer && (powers.files_read || powers.files_write || powers.screen || powers.control)) {
      // Tool use runs without streaming; each step is still shown as it happens.
      params.max_tokens = 16000;
      try {
        await runWithTools({
          client: this.clientFactory(this.apiKey),
          params,
          powers,
          execute: this.computer.execute,
          emit,
          signal,
          approvals: this.approvals,
          askFirst: powers.askFirst,
        });
      } catch (err) {
        if (signal?.aborted) emit({ type: "stopped" });
        else emit({ type: "error", message: describeError(err) });
      }
      return;
    }
    const stream = this.clientFactory(this.apiKey).messages.stream(params);
    const onAbort = () => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") emit({ type: "text", text: ev.delta.text });
          else if (ev.delta.type === "thinking_delta") emit({ type: "thinking", text: ev.delta.thinking });
        }
      }
      const final = await stream.finalMessage();
      emit({
        type: "done",
        stop_reason: final.stop_reason,
        model: final.model,
        usage: final.usage,
        stop_details: final.stop_details ?? null,
      });
    } catch (err) {
      if (signal?.aborted) emit({ type: "stopped" });
      else emit({ type: "error", message: describeError(err) });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
