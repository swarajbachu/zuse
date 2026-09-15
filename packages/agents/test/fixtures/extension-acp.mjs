import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.ZUSE_ACP_TEST_PID)
	writeFileSync(process.env.ZUSE_ACP_TEST_PID, String(process.pid));

const scenario = process.argv[2],
	cursor = "native-session";
let prompt = null;
const send = (value) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id, value) => send({ id, result: value });
const update = (text) =>
	send({
		method: "session/update",
		params: {
			sessionId: cursor,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
			},
		},
	});
const complete = (text) => {
	update(text);
	result(prompt, { stopReason: "end_turn" });
	prompt = null;
};
createInterface({ input: process.stdin })
	.on("line", (line) => {
		const message = JSON.parse(line),
			{ id, method, params } = message;
		if (method === "initialize") {
			if (scenario === "hang-init") return;
			if (scenario === "bad-init") {
				process.stdout.write("not json\n");
				return;
			}
			result(id, {
				protocolVersion: 1,
				agentCapabilities: { loadSession: scenario !== "no-resume" },
			});
			return;
		}
		if (method === "session/new" || method === "session/load") {
			result(id, { sessionId: cursor });
			return;
		}
		if (method === "session/set_model" || method === "session/set_mode") {
			result(id, {});
			return;
		}
		if (method === "session/prompt") {
			prompt = id;
			const text = params.prompt[0].text;
			if (text === "exit") {
				process.exit(9);
				return;
			}
			if (text === "overflow") {
				process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
				return;
			}
			if (text === "permission") {
				send({
					id: "permission-1",
					method: "session/request_permission",
					params: {
						sessionId: cursor,
						toolCall: {
							title: "Run a workspace command",
							rawInput: { command: "echo fixture" },
						},
						options: [
							{ optionId: "yes", name: "Allow once", kind: "allow_once" },
							{ optionId: "always", name: "Always", kind: "allow_always" },
							{ optionId: "no", name: "Deny", kind: "reject_once" },
						],
					},
				});
				return;
			}
			if (text === "wait") return;
			complete("Hello " + text);
			return;
		}
		if (method === "session/cancel") {
			if (scenario !== "ignore-cancel" && prompt !== null)
				complete("Cancelled");
			return;
		}
		if (id === "permission-1") {
			complete(
				message.result.outcome.optionId === "yes" ? "Approved" : "Denied",
			);
			return;
		}
		send({ id, error: { code: -32601, message: "unsupported" } });
	})
	.on("close", () => process.exit(0));
