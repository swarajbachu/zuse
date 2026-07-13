export interface ToolCallResult {
  readonly output: unknown;
  readonly isError: boolean;
}

export interface NormalizedToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly result: ToolCallResult | undefined;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const unwrapMcpOutput = (
  result: ToolCallResult | undefined,
): ToolCallResult | undefined => {
  if (result === undefined) return undefined;
  const envelope = recordOf(result.output);
  if (envelope?.type !== "MCP") return result;
  const output = recordOf(envelope.output);
  if (output === null) return result;
  if ("OkayOutput" in output) {
    return { output: output.OkayOutput, isError: result.isError };
  }
  if ("ErrorOutput" in output) {
    return { output: output.ErrorOutput, isError: true };
  }
  return result;
};

export const normalizeToolCallEnvelope = (
  tool: string,
  input: unknown,
  result: ToolCallResult | undefined,
): NormalizedToolCall => {
  const envelope = recordOf(input);
  const wrappedTool = envelope?.tool_name;
  const wrapped =
    typeof wrappedTool === "string" &&
    (tool === "Use Tool" || envelope?.variant === "UseTool");
  return {
    tool: wrapped ? wrappedTool : tool,
    input: wrapped ? (envelope?.tool_input ?? {}) : input,
    result: unwrapMcpOutput(result),
  };
};
