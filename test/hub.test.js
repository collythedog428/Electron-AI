import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hub, HttpError, hintFor } from "../lib/hub.js";
import { KeyStore } from "../lib/key-store.js";
import { FALLBACK_MODELS } from "../lib/models.js";

// Fake safeStorage: reversible but not plaintext on disk, so we can check the file.
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString("base64")}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), "base64").toString(),
};

const GOOD_KEY = "sk-ant-api03-" + "x".repeat(40);

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hub-test-"));
  const file = path.join(dir, "api-key.bin");
  return { dir, file, store: new KeyStore({ file, crypto: fakeCrypto }) };
}

// A client whose models.list works and whose stream yields canned events.
function fakeClient({ listOk = true, events = [], finalStop = "end_turn", streamError = null } = {}) {
  return {
    models: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          if (!listOk) {
            const { default: Anthropic } = await import("@anthropic-ai/sdk");
            throw new Anthropic.AuthenticationError(401, {}, "bad key", new Headers());
          }
          yield { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" };
        },
      }),
    },
    messages: {
      stream: () => {
        const it = {
          aborted: false,
          abort() { this.aborted = true; },
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
            if (streamError) throw streamError;
          },
          async finalMessage() {
            return { stop_reason: finalStop, model: "claude-opus-5-5", usage: {}, stop_details: null };
          },
        };
        return it;
      },
    },
  };
}

test("status reports no key on a fresh store", async () => {
  const { dir, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    await hub.init();
    assert.deepEqual(hub.status(), { name: "", hasKey: false, hint: null, storageAvailable: true, loadError: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveKey rejects malformed and admin keys without touching disk", async () => {
  const { dir, file, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    await assert.rejects(hub.saveKey("not-a-key"), HttpError);
    await assert.rejects(hub.saveKey("sk-ant-admin01-" + "y".repeat(30)), /Admin keys/);
    await assert.rejects(readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveKey verifies, encrypts at rest, and never stores plaintext", async () => {
  const { dir, file, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    const result = await hub.saveKey(GOOD_KEY);
    assert.equal(result.hint, hintFor(GOOD_KEY));
    const onDisk = await readFile(file, "utf8");
    assert.ok(!onDisk.includes(GOOD_KEY), "plaintext key must not be on disk");
    assert.ok(!JSON.stringify(hub.status()).includes(GOOD_KEY), "status must not expose the key");

    // A fresh hub unlocks the same key from disk.
    const hub2 = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    await hub2.init();
    assert.equal(hub2.status().hasKey, true);
    assert.equal(hub2.status().hint, hintFor(GOOD_KEY));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveKey refuses keys Anthropic rejects and stores nothing", async () => {
  const { dir, file, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient({ listOk: false }) });
    await assert.rejects(hub.saveKey(GOOD_KEY), /Key check failed/);
    await assert.rejects(readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteKey removes the stored blob", async () => {
  const { dir, file, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    await hub.saveKey(GOOD_KEY);
    await hub.deleteKey();
    assert.equal(hub.status().hasKey, false);
    await assert.rejects(readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("models falls back to the built-in list when no key is saved", async () => {
  const { dir, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    const res = await hub.models();
    assert.equal(res.source, "builtin");
    assert.deepEqual(res.models, FALLBACK_MODELS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat rejects invalid bodies before streaming", async () => {
  const { dir, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    await hub.saveKey(GOOD_KEY);
    const emitted = [];
    const emit = (e) => emitted.push(e);
    await assert.rejects(hub.chat({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }, emit), /Invalid model/);
    await assert.rejects(hub.chat({ model: "claude-opus-5-5", messages: [] }, emit), /1-200/);
    await assert.rejects(
      hub.chat({ model: "claude-opus-5-5", messages: [{ role: "assistant", content: "hi" }] }, emit),
      /start and end with a user/,
    );
    assert.equal(emitted.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat without a key is refused", async () => {
  const { dir, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient() });
    await assert.rejects(
      hub.chat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, () => {}),
      /No API key/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat streams text, thinking and done events", async () => {
  const { dir, store } = await tempStore();
  try {
    const events = [
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    ];
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient({ events }) });
    await hub.saveKey(GOOD_KEY);
    const out = [];
    await hub.chat(
      { model: "claude-opus-5-5", thinking: true, effort: "high", messages: [{ role: "user", content: "hi" }] },
      (e) => out.push(e),
    );
    assert.deepEqual(out.map((e) => e.type), ["thinking", "text", "text", "done"]);
    assert.equal(out[1].text + out[2].text, "Hello");
    assert.equal(out[3].stop_reason, "end_turn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat reports stream errors as sanitized error events", async () => {
  const { dir, store } = await tempStore();
  try {
    const hub = new Hub({ keyStore: store, clientFactory: () => fakeClient({ streamError: new Error("boom " + GOOD_KEY) }) });
    await hub.saveKey(GOOD_KEY);
    const out = [];
    await hub.chat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, (e) => out.push(e));
    assert.equal(out.at(-1).type, "error");
    assert.ok(!JSON.stringify(out).includes(GOOD_KEY), "errors must never echo the key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
