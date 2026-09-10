export function fixture(overrides = {}) {
  return {
    format: "tbrain.transfer.v1",
    source_id: "11111111-1111-4111-8111-111111111111",
    source_key: "synthetic-day-1", revision: "1",
    source: { platform: "chatgpt", conversation_id: null, title: "Synthetic day", project: null },
    coverage: { kind: "model_assembled", completeness: "partial", from: null, until: null,
      limitations: ["Only supplied messages are available."], omissions: [] },
    messages: [
      { id: null, role: "user", speaker: null, text: "Maybe I could learn pottery.", at: null, fidelity: "verbatim" },
      { id: null, role: "assistant", speaker: null, text: "That is a possibility, not a commitment.", at: null, fidelity: "verbatim" },
    ],
    reflection: { author: "assistant", status: "provisional", text: "A possible interest to revisit.", message_ordinals: [0] },
    relation: null,
    ...overrides,
  };
}
