import { PassThrough } from "node:stream";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { AcpConnection, AcpResponseError } from "./connection.js";

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
