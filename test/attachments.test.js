import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hub, HttpError } from "../lib/hub.js";
import { KeyStore } from "../lib/key-store.js";

const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};
const KEY = "sk-ant-api03-" + "x".repeat(40);

// Records the params the hub would send to Anthropic.
function recordingClient(sent) {
  return {
    models: { list: () => ({ async *[Symbol.asyncIterator]() { yield { id: "claude-haiku-5-5" }; } }) },
    messages: {
      stream: (params) => {
        sent.push(params);
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {},
          async finalMessage() {
            return { stop_reason: "end_turn", model: "claude-haiku-5-5", usage: {}, stop_details: null };
          },
        };
      },
    },
  };
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "att-test-"));
  const store = new KeyStore({ file: path.join(dir, "k.bin"), crypto: fakeCrypto });
  const sent = [];
  const hub = new Hub({ keyStore: store, clientFactory: () => recordingClient(sent) });
  await hub.saveKey(KEY);
  return { dir, hub, sent };
}

const img = (data = "aGVsbG8=", media = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type: media, data },
});

test("valid image, PDF and text blocks are passed through", async () => {
  const { dir, hub, sent } = await setup();
  try {
    await hub.chat(
      {
        model: "claude-haiku-5-5",
        messages: [
          {
            role: "user",
            content: [
              img(),
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
              { type: "text", text: "describe these" },
            ],
          },
        ],
      },
      () => {},
    );
    const blocks = sent[0].messages[0].content;
    assert.deepEqual(blocks.map((b) => b.type), ["image", "document", "text"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an image with a disallowed type is rejected before anything is sent", async () => {
  const { dir, hub, sent } = await setup();
  try {
    await assert.rejects(
      hub.chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: [img("aGVsbG8=", "image/svg+xml")] }] }, () => {}),
      (err) => err instanceof HttpError && err.status === 400,
    );
    assert.equal(sent.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks that are not base64, or unknown block types, are rejected", async () => {
  const { dir, hub } = await setup();
  try {
    const bad = [
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "not base64!" } },
      { type: "tool_use", id: "x" },
    ];
    for (const block of bad) {
      await assert.rejects(
        hub.chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: [block] }] }, () => {}),
        HttpError,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an oversized image is rejected", async () => {
  const { dir, hub } = await setup();
  try {
    const huge = "A".repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));
    await assert.rejects(
      hub.chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: [img(huge)] }] }, () => {}),
      /under 5 MB/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
