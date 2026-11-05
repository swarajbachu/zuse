import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";

test("real SQLite DO alarms deliver over WebSockets and retain ACKs across restart", async () => {
	const bundle = await build({
		entryPoints: [
			new URL("./automation-object-worker.ts", import.meta.url).pathname,
		],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		external: ["node:*"],
	});
	const script = bundle.outputFiles[0]?.text;
	if (!script) throw new Error("Missing test worker");
	const directory = await mkdtemp(join(tmpdir(), "zuse-automation-do-"));
	const options = {
		modules: true,
		script,
		compatibilityDate: "2026-06-01",
		compatibilityFlags: ["nodejs_compat"],
		durableObjects: {
			SCHEDULER: { className: "AutomationScheduler", useSQLite: true },
		},
		durableObjectsPersist: directory,
	};
	let mf = new Miniflare(options);
	const post = async (path: string, body: Record<string, unknown> = {}) => {
		const response = await mf.dispatchFetch(`https://test/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				accountId: "owner",
				workspaceId: "workspace",
				...body,
			}),
		});
		expect(response.status).toBe(200);
		return response.json();
	};
	try {
		await post("import");
		const idle = await mf.dispatchFetch("https://test/__alarm");
		expect(await idle.json()).toEqual({ alarm: null });
		const connection = await mf.dispatchFetch(
			"https://test/connect?accountId=owner&workspaceId=workspace",
			{
				headers: {
					Upgrade: "websocket",
					"Sec-WebSocket-Protocol": "zuse-automation-events,credential",
				},
			},
		);
		expect(connection.status).toBe(101);
		expect(connection.headers.get("Sec-WebSocket-Protocol")).toBe(
			"zuse-automation-events",
		);
		const socket = connection.webSocket;
		if (!socket) throw new Error("Missing socket");
		socket.accept();
		const available = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("No alarm notification")),
				10_000,
			);
			socket.addEventListener(
				"message",
				(event) => {
					clearTimeout(timer);
					resolve(String(event.data));
				},
				{ once: true },
			);
		});
		const occurrence = new Date(Date.now() + 150).toISOString();
		await post("register", {
			definitions: [
				{
					id: "rule",
					revision: 1,
					enabled: true,
					nextRunAt: occurrence,
					triggers: [
						{
							_tag: "schedule",
							cron: "* * * * *",
							onceAt: occurrence,
							timezone: "UTC",
						},
					],
				},
			],
		});
		expect(JSON.parse(await available)).toEqual({ type: "available" });
		const pending = (await post("pending")) as {
			events: { id: string; eventId: string; source: string }[];
		};
		expect(pending.events).toHaveLength(1);
		expect(pending.events[0]).toMatchObject({
			eventId: occurrence,
			source: "schedule",
		});
		await post("ack", { id: pending.events[0]?.id });
		socket.close();
		await mf.dispose();
		mf = new Miniflare(options);
		expect(await post("pending")).toEqual({ events: [] });
		// Re-registering the same revision cannot replay the completed one-shot cursor.
		await post("register", {
			definitions: [
				{
					id: "rule",
					revision: 1,
					enabled: true,
					nextRunAt: occurrence,
					triggers: [
						{
							_tag: "schedule",
							cron: "* * * * *",
							onceAt: occurrence,
							timezone: "UTC",
						},
					],
				},
			],
		});
		expect(await post("pending")).toEqual({ events: [] });
	} finally {
		await mf.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
