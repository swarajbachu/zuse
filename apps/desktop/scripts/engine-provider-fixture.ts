import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export const ENGINE_TOOL_COMMAND =
	process.platform === "win32"
		? "$PID | Set-Content tool-pid.txt; Add-Content tool-started.txt started; Start-Sleep -Seconds 30; Set-Content tool-finished.txt finished"
		: "echo $$ > tool-pid.txt; printf 'started\\n' >> tool-started.txt; sleep 30; printf 'finished\\n' > tool-finished.txt";

/** Real provider executable and real shell tools; only model inference is scripted locally. */
export const startEngineProviderFixture = async (directory: string) => {
	const providerHome = join(directory, "provider-fixture");
	await mkdir(providerHome);
	let requests = 0;
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				bytes += chunk.length;
				if (bytes > 16 * 1024 * 1024)
					throw new Error("Unexpected fixture request size");
				chunks.push(Buffer.from(chunk));
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests++;
			assert(Array.isArray(body.input));
			response.writeHead(200, { "content-type": "text/event-stream" });

			if (
				body.input.some(
					(item: { type?: string }) =>
						item.type === "function_call" ||
						item.type === "function_call_output",
				)
			)
				return;
			const names = new Set(
				(body.tools ?? []).map((tool: { name?: string }) => tool.name),
			);

			const toolName = names.has("shell_command")
				? "shell_command"
				: "exec_command";
			assert(
				names.has(toolName),
				"Provider did not advertise a native shell tool",
			);
			const id = `fixture-response-${requests}`;
			const events = [
				{ type: "response.created", response: { id } },
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: `fixture-call-${requests}`,
						name: toolName,
						arguments: JSON.stringify(
							toolName === "shell_command"
								? { command: ENGINE_TOOL_COMMAND, timeout_ms: 60_000 }
								: {
										cmd: ENGINE_TOOL_COMMAND,
										yield_time_ms: 30_000,
										max_output_tokens: 1000,
									},
						),
					},
				},
				{
					type: "response.completed",
					response: {
						id,
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			];
			for (const event of events)
				response.write(
					`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
				);
			response.end();
		} catch (error) {
			console.error(
				"Local provider fixture failed:",
				error instanceof Error ? error.message : "invalid request",
			);
			response.destroy();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address !== null && typeof address === "object");
	await writeFile(
		join(providerHome, "config.toml"),
		`model = "gpt-5.5"\nmodel_provider = "engine_fixture"\n[model_providers.engine_fixture]\nname = "Engine test fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
	);
	return {
		environment: {
			CODEX_HOME: providerHome,
			CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
		},
		requestCount: () => requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};
