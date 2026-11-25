import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// import-formats.js is a browser script (no exports), so load its functions into this test.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, "..", "public", "import-formats.js"), "utf8");
const { isForeignConversation, normaliseForeignConversation } = new Function(
  `${source}; return { isForeignConversation, normaliseForeignConversation };`,
)();

test("ChatGPT conversations follow the current branch and skip system messages", () => {
  const conv = {
    title: "Trip plans",
    current_node: "n3",
    mapping: {
      root: { id: "root", parent: null, message: null },
      sys: { parent: "root", message: { author: { role: "system" }, content: { parts: [""] } } },
      n1: { parent: "sys", message: { author: { role: "user" }, content: { parts: ["Plan a trip"] } } },
      n2: { parent: "n1", message: { author: { role: "assistant" }, content: { parts: ["Where to?"] } } },
      n2b: { parent: "n1", message: { author: { role: "assistant" }, content: { parts: ["A discarded branch"] } } },
      n3: { parent: "n2", message: { author: { role: "user" }, content: { parts: ["Japan"] } } },
    },
  };
  assert.equal(isForeignConversation(conv), true);
  const out = normaliseForeignConversation(conv);
  assert.equal(out.title, "Trip plans");
  assert.deepEqual(out.messages, [
    { role: "user", content: "Plan a trip" },
    { role: "assistant", content: "Where to?" },
    { role: "user", content: "Japan" },
  ]);
});

test("Claude conversations map human and assistant senders", () => {
  const conv = {
    name: "Essay help",
    chat_messages: [
      { sender: "human", text: "Help with my essay" },
      { sender: "assistant", text: "" , content: [{ type: "text", text: "Sure, paste it." }] },
      { sender: "human", text: "   " },
      { sender: "system", text: "ignored" },
    ],
  };
  assert.equal(isForeignConversation(conv), true);
  const out = normaliseForeignConversation(conv);
  assert.equal(out.title, "Essay help");
  assert.deepEqual(out.messages, [
    { role: "user", content: "Help with my essay" },
    { role: "assistant", content: "Sure, paste it." },
  ]);
});

test("leading assistant replies are dropped so the chat starts with the user", () => {
  const conv = { name: "Hi", chat_messages: [{ sender: "assistant", text: "Hello!" }, { sender: "human", text: "Hey" }] };
  assert.deepEqual(normaliseForeignConversation(conv).messages, [{ role: "user", content: "Hey" }]);
});

test("conversations with nothing usable return null", () => {
  assert.equal(normaliseForeignConversation({ name: "Empty", chat_messages: [{ sender: "human", text: "" }] }), null);
  assert.equal(isForeignConversation({ id: "x", title: "Our own format" }), false);
});
