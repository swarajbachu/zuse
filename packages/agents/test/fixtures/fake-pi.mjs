#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const session = args.includes("--session")
	? args[args.indexOf("--session") + 1]
	: join(process.cwd(), "pi-session.jsonl");
if (
	!args.includes("--no-session") &&
	(!existsSync(session) ||
		(await import("node:fs")).statSync(session).size === 0)
)
	writeFileSync(session, '{"type":"session","id":"test"}\n');
const output = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let model = "test/model";
let waiting = false;
let current = "";
const message = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	model,
	usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1 },
});
const finish = (text) => {
	const result = message(text);
	output({ type: "message_end", message: result });
	output({ type: "agent_end", messages: [result] });
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	if (!args.includes("--no-session"))
		appendFileSync(join(process.cwd(), "commands.jsonl"), `${line}\n`);
	const respond = (data) =>
		output({
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			data,
		});
	switch (command.type) {
		case "get_state":
			setTimeout(() => respond({ sessionFile: session }), 25);
			break;
		case "get_available_models":
			respond({
				models: [
					{
						provider: "test",
						id: "model",
						name: "Test model",
						contextWindow: 1000,
					},
				],
			});
			break;
		case "set_model":
			model = `${command.provider}/${command.modelId}`;
			respond({});
			break;
		case "compact":
			respond({ tokensBefore: 100, estimatedTokensAfter: 20 });
			break;
		case "prompt": {
			current = command.message;
			if (current === "reject") {
				output({
					type: "response",
					id: command.id,
					success: false,
					error: "Prompt rejected",
				});
				break;
			}
			respond({});
			output({ type: "message_start", message: { role: "assistant" } });
			if (current === "crash") {
				output({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "partial",
					},
				});
				process.exit(7);
			}
			if (current === "malformed") {
				process.stdout.write("not json\n");
				break;
			}
			if (current === "wait") {
				waiting = true;
				break;
			}
			if (current.startsWith("dialog:")) {
				const method =
					current.slice(7) === "timeout" ? "confirm" : current.slice(7);
				output({
					type: "extension_ui_request",
					id: "question",
					method,
					title: "Continue?",
					timeout: current === "dialog:timeout" ? 20 : undefined,
					options: ["first", "second"],
					prefill: method === "editor" ? "original" : undefined,
				});
				if (current === "dialog:timeout")
					setTimeout(() => finish("timed out"), 40);
				break;
			}
			const text = command.images?.length
				? `images:${command.images.length}`
				: `hello\u2028world\u2029:${model}`;
			const delta = JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: text,
				},
			});
			process.stdout.write(delta.slice(0, 13));
			setTimeout(() => {
				process.stdout.write(`${delta.slice(13)}\r\n`);
				output({
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "edit",
					args: { path: "a.txt", oldText: "a", newText: "b" },
				});
				output({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					result: { content: [{ type: "text", text: "tool failed" }] },
					isError: true,
				});
				finish(text);
			}, 15);
			break;
		}
		case "extension_ui_response":
			finish(JSON.stringify(command));
			break;
		case "clear_queue":
			respond({ steering: [], followUp: [] });
			break;
		case "abort":
			if (waiting) {
				waiting = false;
				output({ type: "agent_end", messages: [] });
			}
			respond({});
			break;
		case "hang":
			break;
		case "exit":
			process.exit(8);
			break;
		default:
			respond({});
	}
});
