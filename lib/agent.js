// Runs a conversation where Claude can use tools. Every tool call is checked against the
// powers the user switched on, and (if "ask first" is on) waits for the user's Allow or Deny.
import { toolsForPowers } from "./computer.js";

export const MAX_TOOL_STEPS = 12;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// A short, plain description of what a tool call will do, for the approval card.
export function describeToolCall(name, input = {}) {
  switch (name) {
    case "list_directory": return `List the folder ${input.path}`;
    case "read_file": return `Read the file ${input.path}`;
    case "write_file": return `Write to the file ${input.path} (${String(input.content ?? "").length} characters)`;
    case "take_screenshot": return "Take a screenshot of your screen";
    case "mouse_click": return `Click at ${input.x}, ${input.y}${input.button && input.button !== "left" ? ` (${input.button})` : ""}`;
    case "type_text": return `Type "${String(input.text ?? "").slice(0, 80)}"`;
    case "press_keys": return `Press ${input.keys}`;
    default: return name;
  }
}

// `approvals` is an object with request(id, info) returning a Promise<boolean>.
export async function runWithTools({ client, params, powers, execute, emit, signal, approvals, askFirst }) {
  const tools = toolsForPowers(powers);
  const messages = params.messages.map((m) => ({ ...m }));
  let nextId = 0;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (signal?.aborted) return emit({ type: "stopped" });
    const response = await client.messages.create(
      { ...params, messages, ...(tools.length ? { tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })) } : {}) },
      { signal },
    );

    for (const block of response.content) {
      if (block.type === "text" && block.text) emit({ type: "text", text: block.text });
    }

    if (response.stop_reason !== "tool_use") {
      return emit({ type: "done", stop_reason: response.stop_reason, model: response.model, usage: response.usage, stop_details: response.stop_details ?? null });
    }

    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const toolId = `${block.id}-${nextId++}`;
      const description = describeToolCall(block.name, block.input);
      const allowed = tools.some((t) => t.name === block.name);
      if (!allowed) {
        results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "This tool is switched off in Settings." });
        emit({ type: "tool", toolId, name: block.name, description, status: "blocked" });
        continue;
      }

      if (askFirst) {
        emit({ type: "approval", toolId, name: block.name, description });
        const ok = await approvals.request(toolId, { name: block.name, description }, signal);
        if (!ok) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "The user declined this action." });
          emit({ type: "tool", toolId, name: block.name, description, status: "declined" });
          continue;
        }
      }

      emit({ type: "tool", toolId, name: block.name, description, status: "running" });
      try {
        const out = await execute(block.name, block.input ?? {});
        const content = out.image
          ? [
              { type: "image", source: { type: "base64", media_type: "image/png", data: out.image } },
              { type: "text", text: out.text ?? "" },
            ]
          : out.text ?? "";
        results.push({ type: "tool_result", tool_use_id: block.id, content });
        emit({ type: "tool", toolId, name: block.name, description, status: "done" });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: err.message || "The action failed." });
        emit({ type: "tool", toolId, name: block.name, description, status: "failed", error: err.message });
      }
    }
    messages.push({ role: "user", content: results });
  }
  emit({ type: "error", message: "Spark stopped after too many steps in a row. Ask again with a smaller task." });
}

// Keeps approval requests waiting until the user answers in the chat.
export function createApprovals() {
  const pending = new Map();
  return {
    request(id, info, signal) {
      return new Promise((resolve) => {
        const finish = (ok) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
        pending.set(id, finish);
        signal?.addEventListener("abort", () => finish(false), { once: true });
      });
    },
    answer(id, allow) {
      const finish = pending.get(id);
      if (finish) finish(Boolean(allow));
      return Boolean(finish);
    },
  };
}
