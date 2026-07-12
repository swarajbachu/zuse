#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import readline from "node:readline";

if (process.argv.includes("--version")) {
	process.stdout.write("0.0.0-zuse-test\n");
	process.exit(0);
}

const scenario = process.env.ZUSE_FAKE_ACP_SCENARIO || "complete";
const sessions = new Map();
const pendingPrompts = new Map();
let control = null;

const stateDirectory = process.env.ZUSE_FAKE_ACP_STATE_DIR || "";
if (stateDirectory.length > 0) mkdirSync(stateDirectory, { recursive: true });
const statePath = (sessionId) =>
	join(stateDirectory, `${encodeURIComponent(sessionId)}.json`);
const readSession = (sessionId) => {
	if (stateDirectory.length === 0 || !existsSync(statePath(sessionId)))
		return null;
	return JSON.parse(readFileSync(statePath(sessionId), "utf8"));
};
const writeSession = (sessionId, state) => {
	if (stateDirectory.length === 0) return;
	const target = statePath(sessionId);
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state));
	renameSync(temporary, target);
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const report = (event, fields = {}) => {
	if (control?.writable)
		control.write(`${JSON.stringify({ event, ...fields })}\n`);
};
const update = (sessionId, value) =>
	write({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId,
			update: { sessionUpdate: "agent_message_chunk", content: value },
		},
	});
const complete = (id, sessionId, suffix = "") => {
	if (suffix.length > 0) update(sessionId, suffix);
	write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
	pendingPrompts.delete(id);
	report("prompt.completed", { sessionId });
};

const controlPort = Number(process.env.ZUSE_FAKE_ACP_CONTROL_PORT || 0);
if (controlPort > 0) {
	control = net.connect(controlPort, "127.0.0.1", () =>
		report("provider.connected", { pid: process.pid }),
	);
	let buffer = "";
	control.on("data", (chunk) => {
		buffer += String(chunk);
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n");
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.length === 0) continue;
			const command = JSON.parse(line);
			const pending = [...pendingPrompts.entries()][0];
			if (command.action === "complete" && pending) {
				complete(pending[0], pending[1], command.text || " world");
			} else if (command.action === "crash") {
				process.exit(Number(command.code || 42));
			}
		}
	});
}

const handleRequest = (message) => {
	const { id, method, params = {} } = message;
	if (method === "initialize") {
		write({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: 1,
				authMethods: [{ id: "cached_token", name: "Deterministic test auth" }],
				agentCapabilities: { loadSession: true },
			},
		});
		return;
	}
	if (method === "authenticate") {
		write({ jsonrpc: "2.0", id, result: {} });
		return;
	}
	if (method === "session/new") {
		const sessionId = `fake-acp-${randomUUID()}`;
		const state = { cwd: params.cwd, pendingPermission: null };
		sessions.set(sessionId, state);
		writeSession(sessionId, state);
		write({ jsonrpc: "2.0", id, result: { sessionId } });
		report("session.created", { sessionId, cwd: params.cwd });
		return;
	}
	if (method === "session/load") {
		const persisted = readSession(params.sessionId);
		if (persisted === null) {
			write({
				jsonrpc: "2.0",
				id,
				error: { code: -32001, message: "Unknown persisted session" },
			});
			return;
		}
		const state = { ...persisted, cwd: params.cwd };
		sessions.set(params.sessionId, state);
		writeSession(params.sessionId, state);
		if (state.pendingPermission !== null) {
			const permissionRequestId = 800000 + Number(id);
			pendingPrompts.set(permissionRequestId, {
				kind: "resumed-permission",
				loadId: id,
				sessionId: params.sessionId,
			});
			write({
				jsonrpc: "2.0",
				id: permissionRequestId,
				method: "fs/write_text_file",
				params: state.pendingPermission,
			});
			report("permission.resumed", { sessionId: params.sessionId });
			return;
		}
		write({ jsonrpc: "2.0", id, result: { sessionId: params.sessionId } });
		report("session.loaded", { sessionId: params.sessionId });
		return;
	}
	if (method === "session/prompt") {
		const sessionId = params.sessionId;
		const prompt = Array.isArray(params.prompt)
			? params.prompt
					.map((part) => (typeof part?.text === "string" ? part.text : ""))
					.join("\n")
			: "";
		report("prompt.received", { sessionId, prompt });
		if (scenario === "crash") process.exit(42);
		if (scenario === "malformed") process.stdout.write("not-json\n");
		if (scenario === "stall") return;
		if (scenario === "permission") {
			const cwd = sessions.get(sessionId)?.cwd || process.cwd();
			const permissionRequestId = 900000 + Number(id);
			const permission = {
				path: `${cwd}/permission.txt`,
				content: "allowed",
			};
			const state = sessions.get(sessionId) ?? { cwd };
			const nextState = { ...state, pendingPermission: permission };
			sessions.set(sessionId, nextState);
			writeSession(sessionId, nextState);
			pendingPrompts.set(permissionRequestId, {
				kind: "prompt-permission",
				promptId: id,
				sessionId,
			});
			write({
				jsonrpc: "2.0",
				id: permissionRequestId,
				method: "fs/write_text_file",
				params: permission,
			});
			report("permission.requested", { sessionId });
			return;
		}
		update(
			sessionId,
			scenario === "hold" ? "Hello" : "Hello from deterministic provider.",
		);
		if (scenario === "hold") {
			pendingPrompts.set(id, sessionId);
			report("prompt.held", { sessionId });
			return;
		}
		complete(id, sessionId);
		return;
	}
	write({
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: `Unknown method ${method}` },
	});
};

const input = readline.createInterface({
	input: process.stdin,
	crlfDelay: Infinity,
});
input.on("line", (line) => {
	if (line.trim().length === 0) return;
	const message = JSON.parse(line);
	if (message.method === "session/cancel") {
		const pending = [...pendingPrompts.entries()].find(
			(entry) => entry[1] === message.params?.sessionId,
		);
		if (pending) pendingPrompts.delete(pending[0]);
		report("prompt.cancelled", { sessionId: message.params?.sessionId });
		return;
	}
	if (message.id !== undefined && message.method) {
		handleRequest(message);
		return;
	}
	if (message.id !== undefined && pendingPrompts.has(message.id)) {
		const pending = pendingPrompts.get(message.id);
		pendingPrompts.delete(message.id);
		if (pending?.kind === "resumed-permission") {
			const state = sessions.get(pending.sessionId);
			if (state !== undefined) {
				const nextState = { ...state, pendingPermission: null };
				sessions.set(pending.sessionId, nextState);
				writeSession(pending.sessionId, nextState);
			}
			update(pending.sessionId, "Permission accepted.");
			write({
				jsonrpc: "2.0",
				id: pending.loadId,
				result: { sessionId: pending.sessionId },
			});
			report("permission.continued", { sessionId: pending.sessionId });
		} else if (pending?.kind === "prompt-permission") {
			const state = sessions.get(pending.sessionId);
			if (state !== undefined) {
				const nextState = { ...state, pendingPermission: null };
				sessions.set(pending.sessionId, nextState);
				writeSession(pending.sessionId, nextState);
			}
			complete(pending.promptId, pending.sessionId, "Permission accepted.");
		}
	}
});
