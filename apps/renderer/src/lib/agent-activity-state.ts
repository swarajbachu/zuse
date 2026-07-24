import type { Message } from "@zuse/contracts";
import type { OrbState } from "thinking-orbs";

export type AgentActivityState = OrbState;

const SEARCHING_TOOLS = new Set([
	"glob",
	"grep",
	"listdir",
	"listdirectory",
	"read",
	"readfile",
	"search",
	"viewimage",
	"webfetch",
	"websearch",
]);

const SHAPING_TOOLS = new Set([
	"apply_patch",
	"edit",
	"multiedit",
	"write",
	"writefile",
]);

const SOLVING_TOOLS = new Set(["bash", "exec_command"]);

const normalizeToolName = (tool: string): string =>
	tool.replace(/^mcp__memoize__/, "mcp__zuse__").toLowerCase();

export const agentActivityStateForTool = (tool: string): AgentActivityState => {
	const normalized = normalizeToolName(tool);
	const compact = normalized.replace(/[^a-z0-9_]/g, "");

	if (
		normalized === "askuserquestion" ||
		normalized.endsWith("__ask_user_question")
	) {
		return "listening";
	}

	if (
		SEARCHING_TOOLS.has(compact) ||
		normalized.includes("__browser_") ||
		normalized.includes("search") ||
		normalized.includes("grep") ||
		normalized.includes("glob") ||
		normalized.includes("find") ||
		normalized.includes("fetch") ||
		normalized.includes("read_mcp_resource") ||
		normalized.includes("list_mcp_resource")
	) {
		return "searching";
	}

	if (
		SHAPING_TOOLS.has(compact) ||
		normalized.includes("apply_patch") ||
		normalized.includes("file_write") ||
		normalized.includes("write_file") ||
		normalized.includes("create_file") ||
		normalized.includes("multi_edit")
	) {
		return "shaping";
	}

	if (
		SOLVING_TOOLS.has(compact) ||
		normalized.includes("shell") ||
		normalized.includes("terminal") ||
		normalized.includes("command") ||
		normalized.includes("compile") ||
		normalized.includes("build") ||
		normalized.includes("test") ||
		normalized.includes("diagnos")
	) {
		return "solving";
	}

	return "working";
};

const isTurnInput = (message: Message): boolean => {
	const tag = message.content._tag;
	return (
		tag === "user" || tag === "user_rich" || tag === "user_question_answer"
	);
};

/**
 * Resolve the best-known activity for the current live turn. Only unmatched
 * tool calls receive a semantic tool state: after a result lands, the agent is
 * simply working again until it emits its next visible action.
 */
export const deriveAgentActivityState = (
	messages: ReadonlyArray<Message>,
): AgentActivityState => {
	let turnStart = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message !== undefined && isTurnInput(message)) {
			turnStart = index;
			break;
		}
	}

	const completedTools = new Set<string>();
	const answeredQuestions = new Set<string>();
	for (let index = turnStart + 1; index < messages.length; index += 1) {
		const content = messages[index]?.content;
		if (content?._tag === "tool_result") completedTools.add(content.itemId);
		if (content?._tag === "user_question_answer") {
			answeredQuestions.add(content.itemId);
		}
	}

	for (let index = messages.length - 1; index > turnStart; index -= 1) {
		const message = messages[index];
		if (message === undefined) continue;
		const content = message.content;
		switch (content._tag) {
			case "assistant":
				if (content.text.trim().length > 0) return "composing";
				break;
			case "user_question":
				if (!answeredQuestions.has(content.itemId)) return "listening";
				break;
			case "tool_use":
				if (!completedTools.has(content.itemId)) {
					return agentActivityStateForTool(content.tool);
				}
				break;
			case "tool_result":
				return "working";
		}
	}

	return "working";
};
