import type { Message, MessageContent } from "@zuse/wire";

export type ToolResultRecord = Extract<MessageContent, { _tag: "tool_result" }>;

export const buildToolResultsByItemId = (
  messages: readonly Message[],
): ReadonlyMap<string, ToolResultRecord> => {
  const map = new Map<string, ToolResultRecord>();
  for (const message of messages) {
    if (message.content._tag === "tool_result") {
      map.set(message.content.itemId, message.content);
    }
  }
  return map;
};

export type EditSummary = {
  path: string;
  added: number;
  removed: number;
  preview: string;
};

export const extractEditSummaries = (
  tool: string,
  input: unknown,
): readonly EditSummary[] => {
  if (!isRecord(input)) return [];
  if (tool === "Edit") {
    const path = stringValue(input.file_path) ?? stringValue(input.path);
    const oldString = stringValue(input.old_string);
    const newString = stringValue(input.new_string);
    if (!path || oldString === undefined || newString === undefined) return [];
    return [buildSummary(path, oldString, newString)];
  }
  if (tool === "Write") {
    const path = stringValue(input.file_path) ?? stringValue(input.path);
    const content = stringValue(input.content);
    if (!path || content === undefined) return [];
    return [buildSummary(path, "", content)];
  }
  if (tool === "MultiEdit") {
    const path = stringValue(input.file_path) ?? stringValue(input.path);
    const edits = input.edits;
    if (!path || !Array.isArray(edits)) return [];
    return edits
      .map((edit, index) => {
        if (!isRecord(edit)) return null;
        const oldString = stringValue(edit.old_string);
        const newString = stringValue(edit.new_string);
        if (oldString === undefined || newString === undefined) return null;
        return buildSummary(
          `${path}${edits.length > 1 ? ` #${index + 1}` : ""}`,
          oldString,
          newString,
        );
      })
      .filter((summary): summary is EditSummary => summary !== null);
  }
  return [];
};

export const summarizeValue = (value: unknown, maxLength = 360): string => {
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

const buildSummary = (
  path: string,
  oldString: string,
  newString: string,
): EditSummary => ({
  path,
  added: lineCount(newString),
  removed: lineCount(oldString),
  preview: newString.length > 0 ? newString : oldString,
});

const lineCount = (value: string): number =>
  value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
