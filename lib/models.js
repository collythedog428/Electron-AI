// Model discovery. The live list comes from the Models API; the fallback list
// is only shown when no key is saved or the API cannot be reached.
export const FALLBACK_MODELS = [
  { id: "claude-fable-5-2", display_name: "Claude Fable 5.2" },
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1" },
  { id: "claude-fable-5", display_name: "Claude Fable 5" },
  { id: "claude-mythos-5-2", display_name: "Claude Mythos 5.2 (verified orgs)" },
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
  { id: "claude-opus-5", display_name: "Claude Opus 5" },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
  { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
];

export async function fetchModels(client) {
  const models = [];
  for await (const m of client.models.list({ limit: 100 })) {
    models.push({
      id: m.id,
      display_name: m.display_name || m.id,
      max_input_tokens: m.max_input_tokens ?? null,
      max_tokens: m.max_tokens ?? null,
    });
  }
  return models;
}
