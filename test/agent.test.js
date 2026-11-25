import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithTools, createApprovals, describeToolCall } from "../lib/agent.js";
import { sendKeysEscape, keyComboToSendKeys, clampCoordinate, toolsForPowers, TOOL_DEFS } from "../lib/computer.js";
import { sanitisePowers } from "../lib/hub.js";

// A fake Claude: returns the scripted responses one by one.
function scriptedClient(responses, seen = []) {
  let i = 0;
  return {
    messages: {
      create: async (params) => {
        seen.push(params);
        return responses[i++];
      },
    },
  };
}

const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const endTurn = (text) => ({ stop_reason: "end_turn", model: "m", usage: {}, content: [{ type: "text", text }] });

test("a tool call runs, its result goes back to Claude, and the reply finishes", async () => {
  const seen = [];
  const client = scriptedClient(
    [{ stop_reason: "tool_use", content: [toolUse("t1", "read_file", { path: "C:\\a.txt" })] }, endTurn("It says hi.")],
    seen,
  );
  const events = [];
  await runWithTools({
    client,
    params: { model: "m", max_tokens: 100, messages: [{ role: "user", content: "read a.txt" }] },
    powers: { files_read: true, files_write: false, screen: false, control: false, askFirst: false },
    execute: async (name) => ({ text: `${name} ok` }),
    emit: (e) => events.push(e),
    signal: undefined,
    approvals: createApprovals(),
    askFirst: false,
  });
  const second = seen[1].messages.at(-1);
  assert.equal(second.role, "user");
  assert.deepEqual(second.content[0], { type: "tool_result", tool_use_id: "t1", content: "read_file ok" });
  assert.ok(events.some((e) => e.type === "tool" && e.status === "done"));
  assert.ok(events.some((e) => e.type === "text" && e.text === "It says hi."));
  assert.equal(events.at(-1).type, "done");
});

test("a tool that is switched off is refused and never runs", async () => {
  const client = scriptedClient([{ stop_reason: "tool_use", content: [toolUse("t2", "write_file", { path: "x", content: "y" })] }, endTurn("ok")]);
  let ran = false;
  const events = [];
  await runWithTools({
    client,
    params: { model: "m", max_tokens: 100, messages: [{ role: "user", content: "write" }] },
    powers: { files_read: true, files_write: false, screen: false, control: false, askFirst: false },
    execute: async () => {
      ran = true;
      return { text: "" };
    },
    emit: (e) => events.push(e),
    approvals: createApprovals(),
    askFirst: false,
  });
  assert.equal(ran, false);
  assert.ok(events.some((e) => e.type === "tool" && e.status === "blocked"));
});

test("when the user denies an action, it does not run", async () => {
  const approvals = createApprovals();
  const client = scriptedClient([{ stop_reason: "tool_use", content: [toolUse("t3", "write_file", { path: "x", content: "y" })] }, endTurn("Okay.")]);
  let ran = false;
  const events = [];
  const run = runWithTools({
    client,
    params: { model: "m", max_tokens: 100, messages: [{ role: "user", content: "write" }] },
    powers: { files_read: false, files_write: true, screen: false, control: false, askFirst: true },
    execute: async () => {
      ran = true;
      return { text: "" };
    },
    emit: (e) => events.push(e),
    approvals,
    askFirst: true,
  });
  // Wait until the approval card is shown, then deny it.
  await new Promise((r) => setTimeout(r, 20));
  const card = events.find((e) => e.type === "approval");
  assert.ok(card, "an approval should be requested");
  assert.equal(approvals.answer(card.toolId, false), true);
  await run;
  assert.equal(ran, false);
  assert.ok(events.some((e) => e.type === "tool" && e.status === "declined"));
});

test("approving lets the action run", async () => {
  const approvals = createApprovals();
  const client = scriptedClient([{ stop_reason: "tool_use", content: [toolUse("t4", "list_directory", { path: "C:\\" })] }, endTurn("Done.")]);
  let ran = false;
  const events = [];
  const run = runWithTools({
    client,
    params: { model: "m", max_tokens: 100, messages: [{ role: "user", content: "list" }] },
    powers: { files_read: true, files_write: false, screen: false, control: false, askFirst: true },
    execute: async () => {
      ran = true;
      return { text: "[]" };
    },
    emit: (e) => events.push(e),
    approvals,
    askFirst: true,
  });
  await new Promise((r) => setTimeout(r, 20));
  approvals.answer(events.find((e) => e.type === "approval").toolId, true);
  await run;
  assert.equal(ran, true);
});

test("the tool loop stops after the step limit", async () => {
  const forever = { stop_reason: "tool_use", content: [toolUse("loop", "read_file", { path: "x" })] };
  const client = scriptedClient(Array(20).fill(forever));
  const events = [];
  await runWithTools({
    client,
    params: { model: "m", max_tokens: 100, messages: [{ role: "user", content: "loop" }] },
    powers: { files_read: true, files_write: false, screen: false, control: false, askFirst: false },
    execute: async () => ({ text: "" }),
    emit: (e) => events.push(e),
    approvals: createApprovals(),
    askFirst: false,
  });
  assert.equal(events.at(-1).type, "error");
});

test("powers default to off and ask-first defaults to on", () => {
  assert.deepEqual(sanitisePowers(undefined), { files_read: false, files_write: false, screen: false, control: false, askFirst: true });
  assert.deepEqual(sanitisePowers({ files_write: "yes", control: true, askFirst: false }), {
    files_read: false,
    files_write: false,
    screen: false,
    control: true,
    askFirst: false,
  });
  assert.equal(toolsForPowers({ files_read: true, files_write: false, screen: false, control: false }).length, 2);
  assert.equal(TOOL_DEFS.every((t) => t.power), true);
});

test("typed text is escaped so every character is literal", () => {
  assert.equal(sendKeysEscape("a+b^c%d~e(f){g}[h]"), "a{+}b{^}c{%}d{~}e{(}f{)}{{}g{}}{[}h{]}");
  assert.equal(sendKeysEscape("plain text"), "plain text");
});

test("key combinations map to SendKeys, and unknown keys are refused", () => {
  assert.equal(keyComboToSendKeys("enter"), "{ENTER}");
  assert.equal(keyComboToSendKeys("ctrl+s"), "^(s)");
  assert.equal(keyComboToSendKeys("Ctrl+Shift+T"), "^+(t)");
  assert.throws(() => keyComboToSendKeys("ctrl+rm -rf"), /Unknown key/);
  assert.throws(() => keyComboToSendKeys("win+r"), /Unknown modifier/);
});

test("coordinates must be whole numbers in range", () => {
  assert.equal(clampCoordinate(10.4), 10);
  assert.throws(() => clampCoordinate(-1));
  assert.throws(() => clampCoordinate(99999));
  assert.throws(() => clampCoordinate("abc"));
});

test("approval descriptions are plain and short", () => {
  assert.equal(describeToolCall("read_file", { path: "C:\\x.txt" }), "Read the file C:\\x.txt");
  assert.equal(describeToolCall("type_text", { text: "hello" }), 'Type "hello"');
});

test("tool and approval events do not use the field name 'id' (the chat request ID owns it)", async () => {
  const approvals = createApprovals();
  const client = scriptedClient([
    { stop_reason: "tool_use", content: [toolUse("t5", "read_file", { path: "x" })] },
    endTurn("ok"),
  ]);
  const events = [];
  const run = runWithTools({
    client,
    params: { model: "m", max_tokens: 100, messages: [{ role: "user", content: "read" }] },
    powers: { files_read: true, files_write: false, screen: false, control: false, askFirst: true },
    execute: async () => ({ text: "" }),
    emit: (e) => events.push(e),
    approvals,
    askFirst: true,
  });
  await new Promise((r) => setTimeout(r, 20));
  const approval = events.find((e) => e.type === "approval");
  assert.equal("id" in approval, false);
  assert.ok(approval.toolId);
  approvals.answer(approval.toolId, true);
  await run;
  for (const e of events.filter((e) => e.type === "tool")) assert.equal("id" in e, false);
});
