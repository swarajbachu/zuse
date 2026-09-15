import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceCommand, DeviceCommandGrant } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DeviceBridgeStorage,
	DeviceCommandBroker,
	type DevicePrincipal,
} from "../../src/device-bridge/broker.ts";

const brokers: DeviceCommandBroker[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const broker of brokers.splice(0)) broker.close();
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const owner: DevicePrincipal = {
	accountId: "account",
	workspaceId: "workspace",
	chatId: "chat",
	sessionId: "session",
	grantEpoch: 0,
	actor: "runtime",
};
const user = { ...owner, actor: "user" as const };
const setup = async () => {
	const cwd = await mkdtemp(join(tmpdir(), "zuse-device-"));
	directories.push(cwd);
	const commands = new Map<string, DeviceCommand>();
	const grants = new Map<string, DeviceCommandGrant>();
	let config: { linkKey: string; enabled?: boolean } | null = null;
	let linkKey = "linked-account";
	let connected = true;
	const storage: DeviceBridgeStorage = {
		loadConfig: async () => config,
		saveConfig: async (key) => {
			config = { linkKey: key };
		},
		commands: async () => [...commands.values()],
		command: async (id) => commands.get(id),
		reserveCommand: async (command) => {
			if (commands.has(command.id)) return false;
			commands.set(command.id, structuredClone(command));
			return true;
		},
		saveCommand: async (command) => {
			commands.set(command.id, structuredClone(command));
		},
		grants: async () => [...grants.values()],
		saveGrant: async (grant) => {
			grants.set(grant.id, grant);
		},
		deleteGrant: async (id) => {
			grants.delete(id);
		},
		clearGrants: async () => {
			grants.clear();
		},
	};
	const create = async () => {
		const broker = new DeviceCommandBroker(storage, async () => ({
			linkKey,
			deviceId: "desktop",
			deviceName: "My Mac",
			homeDirectory: cwd,
			connected,
		}));
		brokers.push(broker);
		await broker.initialize();
		return broker;
	};
	const broker = await create();
	const execute = (id: string, command = "printf hello", principal = owner) =>
		broker.handle({ _tag: "execute", input: { id, command, cwd } }, principal);
	const finish = async (id: string) => {
		await vi.waitFor(
			async () => {
				expect((await storage.command(id))?.state).toBe("completed");
			},
			{ timeout: 5000 },
		);
		return storage.command(id);
	};
	return {
		broker,
		create,
		storage,
		execute,
		finish,
		cwd,
		disconnect: () => {
			connected = false;
		},
		reconnect: () => {
			connected = true;
		},
		legacyDisabled: () => {
			config = { linkKey, enabled: false };
		},
		changeAccount: () => {
			linkKey = "other-account";
		},
	};
};

describe("desktop command authority", () => {
	it("is available by default but never executes without command approval", async () => {
		const { broker, execute } = await setup();
		expect((await broker.status()).enabled).toBe(true);
		expect(await execute("first")).toMatchObject({
			state: "pending",
			stdout: "",
		});
	});
	it("ignores the old disabled preference while still requiring approval", async () => {
		const { broker, legacyDisabled, create, cwd } = await setup();
		broker.close();
		legacyDisabled();
		const restarted = await create();
		expect((await restarted.status()).enabled).toBe(true);
		expect(
			await restarted.handle(
				{
					_tag: "execute",
					input: {
						id: "legacy",
						command: "touch marker",
						cwd,
					},
				},
				owner,
			),
		).toMatchObject({ state: "pending" });
		await expect(readFile(join(cwd, "marker"))).rejects.toThrow();
	});
	it("interrupts work on disconnect and automatically reconnects with fresh approval", async () => {
		const { broker, execute, disconnect, reconnect, storage } = await setup();
		await execute("running", "sleep 30");
		await broker.handle(
			{ _tag: "decide", id: "running", decision: "AlwaysAllow" },
			user,
		);
		disconnect();
		expect(await broker.status()).toMatchObject({ enabled: false, grants: [] });
		expect(await storage.command("running")).toMatchObject({
			state: "interrupted",
		});
		await expect(execute("offline")).rejects.toThrow("linked and signed in");
		reconnect();
		expect((await broker.status()).enabled).toBe(true);
		expect(await execute("reconnected")).toMatchObject({ state: "pending" });
	});
	it("invalidates running commands and saved grants when the account session changes", async () => {
		const { broker, execute, storage } = await setup();
		await execute("running", "sleep 30");
		await broker.handle(
			{ _tag: "decide", id: "running", decision: "AlwaysAllow" },
			user,
		);
		await broker.invalidate();
		expect(await storage.command("running")).toMatchObject({
			state: "interrupted",
		});
		expect((await broker.status()).grants).toEqual([]);
		expect(await execute("after-reset")).toMatchObject({ state: "pending" });
	});

	it("requires approval, returns output and exit status, and never replays an ID", async () => {
		const { broker, execute, cwd, finish } = await setup();
		const command =
			"printf x >> marker; printf hello; printf error >&2; exit 7";
		expect(await execute("once", command)).toMatchObject({
			state: "pending",
			stdout: "",
		});
		await expect(readFile(join(cwd, "marker"))).rejects.toThrow();
		await broker.handle(
			{ _tag: "decide", id: "once", decision: "AllowOnce" },
			user,
		);
		expect(await finish("once")).toMatchObject({
			stdout: "hello",
			stderr: "error",
			exitCode: 7,
		});
		await execute("once", command);
		expect(await readFile(join(cwd, "marker"), "utf8")).toBe("x");
		await expect(execute("once", "printf altered")).rejects.toThrow(
			"already used",
		);
		expect(await execute("twice")).toMatchObject({ state: "pending" });
	});
	it("serializes conflicting approvals and rejects runtime self-approval and cross-account requests", async () => {
		const { broker, execute } = await setup();
		await execute("race");
		await expect(
			broker.handle(
				{ _tag: "decide", id: "race", decision: "AlwaysAllow" },
				owner,
			),
		).rejects.toThrow("User approval");
		await expect(
			broker.handle(
				{ _tag: "poll", id: "race" },
				{ ...owner, accountId: "intruder" },
			),
		).rejects.toThrow("not found");
		const results = await Promise.allSettled([
			broker.handle({ _tag: "decide", id: "race", decision: "Deny" }, user),
			broker.handle(
				{ _tag: "decide", id: "race", decision: "AlwaysAllow" },
				user,
			),
		]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect((await broker.status()).grants).toHaveLength(0);
	});
	it("persists chat grants through restart, isolates other chats, and expires them after archive", async () => {
		const { broker, create, execute, finish, cwd } = await setup();
		await execute("approved");
		await broker.handle(
			{ _tag: "decide", id: "approved", decision: "AllowForSession" },
			user,
		);
		await finish("approved");
		broker.close();
		const restarted = await create();
		expect(
			await restarted.handle(
				{
					_tag: "execute",
					input: { id: "resumed", command: "printf again", cwd },
				},
				owner,
			),
		).toMatchObject({ state: "running" });
		expect(
			await restarted.handle(
				{
					_tag: "execute",
					input: { id: "other-chat", command: "printf other", cwd },
				},
				{ ...owner, chatId: "other" },
			),
		).toMatchObject({ state: "pending" });
		expect(
			await restarted.handle(
				{
					_tag: "execute",
					input: { id: "unarchived", command: "printf other", cwd },
				},
				{ ...owner, grantEpoch: 1 },
			),
		).toMatchObject({ state: "pending" });
	});
	it("always grants apply to this account's chats and revocation stops running commands", async () => {
		const { broker, execute, finish } = await setup();
		await execute("grant");
		await broker.handle(
			{ _tag: "decide", id: "grant", decision: "AlwaysAllow" },
			user,
		);
		await finish("grant");
		expect(
			await execute("long", "sleep 30", { ...owner, chatId: "other" }),
		).toMatchObject({ state: "running" });
		const [grant] = (await broker.status()).grants;
		if (!grant) throw new Error("missing grant");
		await broker.handle({ _tag: "revoke", id: grant.id }, user);
		expect(await broker.handle({ _tag: "poll", id: "long" })).toMatchObject({
			state: "cancelled",
		});
		expect(await execute("needs-permission")).toMatchObject({
			state: "pending",
		});
	});
	it("cancels pending work, clears grants and requires fresh approval on account changes", async () => {
		const { broker, execute, changeAccount } = await setup();
		await execute("pending");
		changeAccount();
		const status = await broker.status();
		expect(status.enabled).toBe(true);
		expect(await execute("new-account")).toMatchObject({ state: "pending" });
		expect(status.commands[0]?.state).toBe("interrupted");
	});
	it("marks interrupted receipts unknown on restart without replay", async () => {
		const { broker, create, execute, storage } = await setup();
		await execute("lost");
		broker.close();
		const restarted = await create();
		expect((await storage.command("lost"))?.state).toBe("unknown");
		expect(
			await restarted.handle({ _tag: "poll", id: "lost" }, owner),
		).toMatchObject({ state: "unknown" });
	});
	it("bounds concurrency and output", async () => {
		const { broker, execute, finish } = await setup();
		await execute("large", "head -c 1100000 /dev/zero");
		await broker.handle(
			{ _tag: "decide", id: "large", decision: "AllowOnce" },
			user,
		);
		const result = await finish("large");
		expect(result?.truncated).toBe(true);
		expect(result?.stdout.length).toBe(1024 * 1024);
		await Promise.all(["a", "b", "c", "d"].map((id) => execute(id)));
		await expect(execute("overload")).rejects.toThrow("busy");
	});
	it("expires pending approvals and running commands when cloud leases stop", async () => {
		const { broker, execute } = await setup();
		await execute("lease", "sleep 30");
		await broker.handle(
			{ _tag: "decide", id: "lease", decision: "AllowOnce" },
			user,
		);
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 20000);
		await vi.waitFor(
			async () => {
				expect((await broker.status()).commands[0]?.state).toBe("interrupted");
			},
			{ timeout: 2500 },
		);
		vi.restoreAllMocks();
	});
});
