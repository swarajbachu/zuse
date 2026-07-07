import type { MessageContent } from "@zuse/wire";

import {
  extractEditSummaries,
  summarizeValue,
  type ToolResultRecord,
} from "./message-presentation";

export type MobileToolIcon =
  | "terminal"
  | "file"
  | "edit"
  | "search"
  | "folder"
  | "agent"
  | "web"
  | "camera"
  | "todo"
  | "wrench";

export type MobileToolPresentation = {
  icon: MobileToolIcon;
  label: string;
  detail: string | null;
  body: string;
  resultBody: string | null;
  resultLabel: "Running" | "Result" | "Error";
  isError: boolean;
  editSummaries: ReturnType<typeof extractEditSummaries>;
};

type ToolUseContent = Extract<MessageContent, { _tag: "tool_use" }>;

export const buildToolPresentation = (
  content: ToolUseContent,
  result?: ToolResultRecord,
): MobileToolPresentation => {
  const normalizedTool = normalizeToolName(content.tool);
  const input = asRecord(content.input);
  const resultText =
    result === undefined ? null : toResultText(result.output) || "(no output)";
  const editSummaries = extractEditSummaries(content.tool, content.input);
  const base = buildBaseToolView(normalizedTool, input, content.input, resultText);

  return {
    ...base,
    resultBody: resultText,
    resultLabel:
      result === undefined ? "Running" : result.isError ? "Error" : "Result",
    isError: result?.isError === true,
    editSummaries,
  };
};

export const toResultText = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (!isRecord(block)) continue;
      if (typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if (isRecord(block.content) && typeof block.content.text === "string") {
        parts.push(block.content.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  if (isRecord(output)) {
    if (typeof output.text === "string") return output.text;
    if (typeof output.content === "string") return output.content;
    if (Array.isArray(output.content)) return toResultText(output.content);
  }
  return summarizeValue(output);
};

export const lineCountOf = (output: unknown): number => {
  const text = toResultText(output);
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
};

const buildBaseToolView = (
  tool: string,
  input: Record<string, unknown>,
  rawInput: unknown,
  resultText: string | null,
): Omit<MobileToolPresentation, "resultBody" | "resultLabel" | "isError" | "editSummaries"> => {
  switch (tool) {
    case "Bash":
    case "Shell":
    case "Execute":
    case "Run":
    case "run_shell_command":
    case "run_terminal_cmd": {
      const command =
        stringValue(input.command) ??
        stringValue(input.cmd) ??
        stringValue(input.shell_command) ??
        stringValue(rawInput);
      const description = stringValue(input.description);
      return {
        icon: "terminal",
        label: description ?? (tool === "Bash" ? "Bash" : "Execute"),
        detail: command === null ? null : command,
        body: command === null ? summarizeValue(rawInput) : `$ ${command}`,
      };
    }
    case "Read":
    case "ReadFile": {
      const path = stringValue(input.file_path) ?? stringValue(input.path);
      const lines =
        resultText === null
          ? "..."
          : resultText.length === 0
            ? "(empty)"
            : `${resultText.split(/\r\n|\r|\n/).length} lines`;
      return {
        icon: "file",
        label: tool === "ReadFile" ? "Read file" : "Read",
        detail: path === null ? lines : `${lines} - ${path}`,
        body: path ?? summarizeValue(rawInput),
      };
    }
    case "Edit":
    case "Write":
    case "WriteFile":
    case "MultiEdit": {
      const path = stringValue(input.file_path) ?? stringValue(input.path);
      return {
        icon: "edit",
        label:
          tool === "Write" || tool === "WriteFile"
            ? "Write"
            : tool === "MultiEdit"
              ? "MultiEdit"
              : "Edit",
        detail: path,
        body: summarizeValue(rawInput),
      };
    }
    case "Grep":
    case "Glob":
    case "Search": {
      const pattern = stringValue(input.pattern) ?? stringValue(input.query);
      const scope =
        stringValue(input.path) ?? stringValue(input.glob) ?? stringValue(input.type);
      const detail =
        pattern === null
          ? scope
          : scope === null
            ? pattern
            : `${pattern} in ${scope}`;
      return {
        icon: "search",
        label: tool,
        detail,
        body: summarizeValue(rawInput),
      };
    }
    case "ListDir":
    case "ListDirectory": {
      const path = stringValue(input.path) ?? stringValue(input.directory);
      return { icon: "folder", label: "List directory", detail: path, body: summarizeValue(rawInput) };
    }
    case "TodoWrite":
    case "TaskUpdate":
      return { icon: "todo", label: "Update tasks", detail: "Project plan", body: summarizeValue(rawInput) };
    case "Task":
    case "Agent":
    case "SpawnAgent":
    case "CollabSpawnAgent":
    case "CollabSendInput":
    case "CollabResumeAgent":
    case "CollabCloseAgent":
    case "CollabWait":
      return {
        icon: "agent",
        label: tool === "Task" ? "Task" : "Agent",
        detail: stringValue(input.description) ?? stringValue(input.prompt),
        body: summarizeValue(rawInput),
      };
    case "WebFetch":
    case "WebSearch":
      return {
        icon: "web",
        label: tool === "WebFetch" ? "Fetch page" : "Search web",
        detail: stringValue(input.url) ?? stringValue(input.query),
        body: summarizeValue(rawInput),
      };
    default: {
      const lower = tool.toLowerCase();
      if (lower.endsWith("__browser_screenshot")) {
        return { icon: "camera", label: "Screenshot", detail: null, body: summarizeValue(rawInput) };
      }
      if (lower.includes("__browser_")) {
        return { icon: "web", label: "Browser", detail: stringValue(input.url), body: summarizeValue(rawInput) };
      }
      if (lower.includes("read") || lower.includes("file")) {
        return { icon: "file", label: tool, detail: null, body: summarizeValue(rawInput) };
      }
      if (lower.includes("search") || lower.includes("grep") || lower.includes("glob")) {
        return { icon: "search", label: tool, detail: null, body: summarizeValue(rawInput) };
      }
      return { icon: "wrench", label: tool, detail: summarizeValue(rawInput, 96), body: summarizeValue(rawInput) };
    }
  }
};

const normalizeToolName = (tool: string): string =>
  tool.replace(/^mcp__memoize__/, "mcp__zuse__");

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
