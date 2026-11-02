#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";

const output = (message) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let cursor = 0;
let sessionId = "native-muse-session";
let turnId;
let running = false;
let approval;
let gapEvents = [];
const event = (method, params) =>
	output({
		method,
		params: {
			sessionId,
			sourceRange: { start: 0, end: 0 },
			viewCursor: String(++cursor),
			...params,
		},
	});
const finish = (terminal = "completed") => {
	running = false;
	event("turn/completed", {
		turnId,
		terminal,
		usage: {
			inputTokens: 12,
			outputTokens: 3,
			cachedTokens: 2,
			reasoningTokens: 0,
		},
	});
};
const item = {
	itemId: "message",
	kind: "agentMessage",
	status: "inProgress",
	revision: 1,
	text: "",
};
const message = () => {
	event("item/started", { item: { ...item, turnId } });
	event("item/delta", { itemId: item.itemId, delta: "Hello 🌍" });
	setTimeout(() => {
		event("item/completed", {
			item: {
				...item,
				turnId,
				text: "Hello 🌍",
				revision: 2,
				status: "completed",
			},
		});
		finish();
	}, 90);
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	appendFileSync(
		join(process.cwd(), "commands.jsonl"),
		`${JSON.stringify({ ...request, pid: process.pid })}\n`,
	);
	const reply = (result) => output({ id: request.id, result });
	const params = request.params ?? {};
	if (request.id === undefined) return;
	switch (request.method) {
		case "initialize":
			if (process.env.FAKE_MUSE_HANG === "1") break;
			reply({
				serverInfo: { name: "fake-muse", version: "1.4.6" },
				schema: { version: 1, fingerprint: EXPECTED_SCHEMA_FINGERPRINT },
				grantedCapabilities:
					process.env.FAKE_MUSE_NO_MCP === "1" ? [] : ["sessionMcp"],
				sessionDurability: "durable",
			});
			break;
		case "view/page":
			reply({ events: gapEvents, nextCursor: null });
			break;
		case "model/list":
			reply({
				providerId: "meta",
				models: [
					{
						modelId: "muse-test",
						displayLabel: "Muse Test",
						providerId: "meta",
						isDefault: true,
						variants: ["high", "max"],
					},
					{
						modelId: "other",
						displayLabel: "Other",
						providerId: "other",
						isDefault: false,
					},
					{
						modelId: "muse-test",
						displayLabel: "Duplicate",
						providerId: "meta",
						isDefault: false,
					},
				],
			});
			break;
		case "session/start":
		case "session/resume":
			if (params.sessionId === "missing") {
				output({
					id: request.id,
					error: {
						code: -32000,
						message: "Session not found",
						data: { kind: "sessionNotFound" },
					},
				});
				break;
			}
			sessionId = params.sessionId ?? sessionId;
			reply({
				session: {
					sessionId,
					permissionState: {
						profileId: process.env.FAKE_MUSE_PROFILE ?? ":ask-me",
					},
				},
				viewCursor: "0",
			});
			break;
		case "session/setApprovalMode":
		case "session/setModel":
			reply({ commandId: params.commandId, status: "accepted" });
			break;
		case "session/compact":
			turnId = params.commandId;
			running = true;
			reply({ commandId: params.commandId, status: "accepted" });
			event("turn/started", { turnId });
			finish();
			break;
		case "turn/start": {
			turnId = params.commandId;
			running = true;
			reply({ turnId, commandId: params.commandId, status: "accepted" });
			event("turn/started", { turnId });
			const text = params.displayText;
			if (text === "gap") {
				const after = String(cursor);
				gapEvents = [
					{
						method: "item/completed",
						params: {
							sessionId,
							sourceRange: { start: 0, end: 0 },
							viewCursor: String(++cursor),
							item: {
								...item,
								turnId,
								revision: 2,
								status: "completed",
								text: "Recovered reply",
							},
						},
					},
					{
						method: "turn/completed",
						params: {
							sessionId,
							sourceRange: { start: 0, end: 0 },
							viewCursor: String(++cursor),
							turnId,
							terminal: "completed",
						},
					},
				];
				output({
					method: "view/gap",
					params: { sessionId, after, next: String(cursor) },
				});
				break;
			}
			if (text === "crash") {
				process.exit(7);
			}
			if (text === "wait") break;
			if (text === "approve") {
				approval = {
					approvalId: "approval",
					itemId: "tool",
					currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
					toolCallId: "tool",
					taskId: "tool",
					toolName: "Write",
					rawArgs: '{"path":"safe.txt"}',
					protectedWrite: process.env.FAKE_MUSE_SENSITIVE === "1",
					judgeEscalated: false,
					subject: { kind: "tool" },
					turnId,
					availableChoices: [
						{
							choiceId: "yes",
							decision: "approved",
							scope: "once",
							label: "Allow",
						},
						{
							choiceId: "no",
							decision: "denied",
							scope: "once",
							label: "Deny",
						},
					],
				};
				event("approval/requested", approval);
				break;
			}
			if (text === "question") {
				event("userInput/requested", {
					userInputId: "question",
					itemId: "question",
					toolCallId: "question",
					toolName: "AskUserQuestion",
					turnId,
					questions: [
						{
							id: "q",
							header: "Pick",
							question: "Which one?",
							options: [{ label: "One" }, { label: "Two" }],
							selection: { mode: "single" },
						},
					],
				});
				break;
			}
			message();
			break;
		}
		case "approval/decide":
			reply({
				commandId: params.commandId,
				status: "accepted",
				terminal: true,
				approvalId: "approval",
			});
			event("approval/resolved", {
				approvalId: "approval",
				decision: params.choiceId === "yes" ? "approved" : "denied",
			});
			message();
			break;
		case "userInput/answer":
			reply({
				commandId: params.commandId,
				status: "accepted",
				userInputId: params.userInputId,
			});
			event("userInput/settled", {
				userInputId: params.userInputId,
				outcome: "answered",
				answers: params.answers,
			});
			message();
			break;
		case "turn/interrupt":
			reply({ commandId: params.commandId, status: "accepted", turnId });
			if (running) finish("cancelled");
			break;
		default:
			reply({});
	}
});
