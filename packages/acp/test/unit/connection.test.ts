import { PassThrough } from "node:stream";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { AcpConnection, AcpResponseError } from "../../src/connection.js";

const nextLine = (stream: PassThrough): Promise<Record<string, unknown>> =>
	new Promise((resolve) => {
		stream.once("data", (chunk) => resolve(JSON.parse(String(chunk).trim())));
	});

describe("AcpConnection", () => {
	test("correlates typed request responses", async () => {
		const inbound = new PassThrough();
		const outbound = new PassThrough();
		const connection = new AcpConnection(inbound, outbound);

		const sent = nextLine(outbound);
		const result = connection.request(
			"session/new",
			{ cwd: "/tmp" },
			Schema.Struct({
				sessionId: Schema.String,
			}),
		);
		const request = await sent;
		inbound.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: { sessionId: "session-1" },
			})}\n`,
		);

		await expect(result).resolves.toEqual({ sessionId: "session-1" });
		connection.close();
	});

	test("surfaces protocol errors and ordered notifications", async () => {
		const inbound = new PassThrough();
		const outbound = new PassThrough();
		const connection = new AcpConnection(inbound, outbound);
		const methods: string[] = [];
		connection.subscribe((message) => methods.push(message.method));

		inbound.write(`${JSON.stringify({ jsonrpc: "2.0", method: "one" })}\n`);
		inbound.write(`${JSON.stringify({ jsonrpc: "2.0", method: "two" })}\n`);

		const sent = nextLine(outbound);
		const result = connection.request("bad", {}, Schema.String);
		const request = await sent;
		inbound.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32_000, message: "failed" },
			})}\n`,
		);

		await expect(result).rejects.toBeInstanceOf(AcpResponseError);
		expect(methods).toEqual(["one", "two"]);
		connection.close();
	});
});

test("answers client requests once and rejects unsupported methods", async () => {
	const inbound = new PassThrough(),
		outbound = new PassThrough();
	const lines: unknown[] = [];
	outbound.on("data", (chunk) => lines.push(JSON.parse(String(chunk))));
	const connection = new AcpConnection(inbound, outbound, {
		onRequest: (_request, respond) => {
			respond({ ok: true });
			respond({ ok: false });
		},
	});
	inbound.write(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "permission",
			params: {},
		}) + "\n",
	);
	expect(lines).toEqual([{ jsonrpc: "2.0", id: 7, result: { ok: true } }]);
	connection.close();
	const unsupported = new AcpConnection(inbound, outbound);
	inbound.write(
		JSON.stringify({ jsonrpc: "2.0", id: 8, method: "unknown" }) + "\n",
	);
	expect(lines.at(-1)).toMatchObject({ id: 8, error: { code: -32601 } });
	unsupported.close();
});

test.each([
	"invalid json\n",
	"x".repeat(257),
])("closes malformed or oversized streams and rejects pending calls", async (data) => {
	const inbound = new PassThrough(),
		outbound = new PassThrough();
	const connection = new AcpConnection(inbound, outbound, {
		maxMessageBytes: 256,
	});
	const pending = connection.request("wait", {}, Schema.Unknown);
	const rejected = expect(pending).rejects.toBeInstanceOf(Error);
	inbound.write(data);
	await rejected;
	await expect(connection.request("again", {}, Schema.Unknown)).rejects.toThrow(
		"closed",
	);
	expect(inbound.listenerCount("data")).toBe(0);
});

test("bounds unanswered client requests", async () => {
	const inbound = new PassThrough(),
		outbound = new PassThrough();
	const connection = new AcpConnection(inbound, outbound, {
		onRequest: () => {},
	});
	const pending = connection.request("wait", {}, Schema.Unknown);
	const rejected = expect(pending).rejects.toThrow("request limit");
	for (let id = 0; id < 33; id++)
		inbound.write(
			JSON.stringify({ jsonrpc: "2.0", id, method: "wait" }) + "\n",
		);
	await rejected;
});
