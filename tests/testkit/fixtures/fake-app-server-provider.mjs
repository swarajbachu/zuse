#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

input.on("line", (line) => {
	const request = JSON.parse(line);
	const result =
		request.method === "initialize"
			? { userAgent: "deterministic-app-server" }
			: request.method === "model/list"
				? { data: [{ id: "deterministic-model" }] }
				: request.method === "thread/start"
					? { thread: { id: "deterministic-thread" } }
					: request.method === "turn/start"
						? { turn: { id: "deterministic-turn" } }
						: null;
	if (result === null) {
		write({
			id: request.id,
			error: { code: -32601, message: "Unknown method" },
		});
		return;
	}
	write({ id: request.id, result });
});
