// Converts chat exports from other AI apps into this app's shape: { title, messages: [{ role, content }] }.
// Supported: ChatGPT (conversations.json) and Claude.ai data exports (conversations.json).

// ChatGPT stores each conversation as a tree of messages. Follow the path from the
// current node back to the root so only the branch the user actually saw is kept.
function fromChatGPT(conv) {
  const map = conv?.mapping;
  if (!map || typeof map !== "object") return null;
  const chain = [];
  const seen = new Set();
  let id = conv.current_node;
  while (id && map[id] && !seen.has(id)) {
    seen.add(id);
    chain.unshift(map[id]);
    id = map[id].parent;
  }
  const messages = [];
  for (const node of chain) {
    const m = node.message;
    const role = m?.author?.role;
    if (role !== "user" && role !== "assistant") continue; // skips system and tool messages
    const parts = m.content?.parts;
    const text = Array.isArray(parts) ? parts.filter((p) => typeof p === "string").join("\n").trim() : "";
    if (text) messages.push({ role, content: text });
  }
  return { title: conv.title, messages };
}

// Claude.ai exports store messages as chat_messages with sender "human" or "assistant".
function fromClaude(conv) {
  if (!Array.isArray(conv?.chat_messages)) return null;
  const messages = [];
  for (const m of conv.chat_messages) {
    const role = m?.sender === "human" ? "user" : m?.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    let text = typeof m.text === "string" ? m.text : "";
    if (!text && Array.isArray(m.content)) {
      text = m.content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
    }
    text = text.trim();
    if (text) messages.push({ role, content: text });
  }
  return { title: conv.name, messages };
}

// Returns true if this item looks like a ChatGPT or Claude conversation.
function isForeignConversation(item) {
  return Boolean(item && typeof item === "object" && (item.mapping || item.chat_messages));
}

// Converts one foreign conversation. Leading assistant replies are dropped, because
// a chat has to start with the user. Returns null if nothing usable is left.
function normaliseForeignConversation(conv) {
  const chat = fromChatGPT(conv) ?? fromClaude(conv);
  if (!chat) return null;
  const messages = [...chat.messages];
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length === 0) return null;
  return { title: chat.title, messages };
}
