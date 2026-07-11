#!/usr/bin/env node
import net from "node:net";
import readline from "node:readline";

if (process.argv.includes("--version")) {
	process.stdout.write("0.0.0-zuse-test\n");
	process.exit(0);
}

const scenario = process.env.ZUSE_FAKE_ACP_SCENARIO || "complete";
const sessions = new Map();
const pendingPrompts = new Map();
let nextSession = 1;
let control = null;

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
		const sessionId = `fake-acp-${nextSession++}`;
		sessions.set(sessionId, { cwd: params.cwd });
		write({ jsonrpc: "2.0", id, result: { sessionId } });
		report("session.created", { sessionId, cwd: params.cwd });
		return;
	}
	if (method === "session/load") {
		sessions.set(params.sessionId, { cwd: params.cwd });
		write({ jsonrpc: "2.0", id, result: { sessionId: params.sessionId } });
		return;
	}
	if (method === "session/prompt") {
		const sessionId = params.sessionId;
		report("prompt.received", { sessionId });
		if (scenario === "crash") process.exit(42);
		if (scenario === "malformed") process.stdout.write("not-json\n");
		if (scenario === "stall") return;
		if (scenario === "permission") {
			const cwd = sessions.get(sessionId)?.cwd || process.cwd();
			const permissionRequestId = 900000 + Number(id);
			pendingPrompts.set(permissionRequestId, { promptId: id, sessionId });
			write({
				jsonrpc: "2.0",
				id: permissionRequestId,
				method: "fs/write_text_file",
				params: { path: `${cwd}/permission.txt`, content: "allowed" },
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
		if (typeof pending === "object" && pending !== null) {
			complete(pending.promptId, pending.sessionId, "Permission accepted.");
		}
	}
});
