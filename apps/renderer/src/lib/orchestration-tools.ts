const ORCHESTRATION_TOOL_RE =
  /^(?:mcp__)?zuse[-_]orchestration__([a-z0-9_]+)$/i;

// Legacy Grok rows persisted before the ACP translator fix used the
// toNiceToolLabel fallback. Match those too so old timelines render cards.
const LEGACY_LABELS: Record<string, string> = {
  "Zuse Orchestration Create Thread": "create_thread",
  "Zuse Orchestration Create Chat": "create_chat",
  "Zuse Orchestration Send To Thread": "send_to_thread",
};

export const orchestrationToolName = (tool: string): string | null =>
  ORCHESTRATION_TOOL_RE.exec(tool)?.[1]?.toLowerCase() ??
  LEGACY_LABELS[tool] ??
  null;

export interface OrchestrationResultJson {
  readonly ok?: boolean;
  readonly chatId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly branch?: string;
  readonly queued?: boolean;
}

const flattenOutputText = (output: unknown): string | null => {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") {
        parts.push(b.text);
        continue;
      }
      const inner = b.content;
      if (inner !== null && typeof inner === "object") {
        const text = (inner as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  if (output !== null && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
    if (Array.isArray(o.content)) return flattenOutputText(o.content);
  }
  return null;
};

export const parseOrchestrationResult = (
  output: unknown,
): OrchestrationResultJson | null => {
  const text = flattenOutputText(output);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as OrchestrationResultJson)
      : null;
  } catch {
    return null;
  }
};
