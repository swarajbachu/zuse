import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wsClientProtocolLayer } from "@zuse/client-runtime/ws-protocol";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { __testing, isAgentCliCommand } from "../src/agent-cli.ts";

describe("agent CLI", () => {
	test("recognizes control-plane commands without stealing serve commands", () => {
		expect(isAgentCliCommand(["chat", "list"])).toBe(true);
		expect(isAgentCliCommand(["session", "send"])).toBe(true);
		expect(isAgentCliCommand(["serve", "status"])).toBe(false);
	});

	test("parses repeatable and inline options", () => {
		const parsed = __testing.parse([
			"session",
			"send",
			"--session=s_1",
			"--file",
			"a.ts",
			"--file",
			"b.ts",
			"--include-archived",
		]);
		expect(parsed.positionals).toEqual(["session", "send"]);
		expect(parsed.flags.get("session")).toEqual(["s_1"]);
		expect(parsed.flags.get("file")).toEqual(["a.ts", "b.ts"]);
		expect(parsed.flags.get("include-archived")).toEqual(["true"]);
	});

	test("publishes a machine-readable command manifest", () => {
		const manifest = __testing.commandManifest();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.commands).toContain("chat create");
		expect(manifest.commands).toContain("session mode");
		expect(manifest.commands).toContain("session send");
		expect(manifest.commands).toContain("session fork");
		expect(manifest.commands).toContain("session model");
		expect(manifest.commands).toContain("session provider");
		expect(manifest.commands).toContain("session transcript");
		expect(manifest.commands).toContain("session plan");
		expect(manifest.commands).toContain("session plan-respond");
		expect(manifest.commands).toContain("session answer");
		expect(manifest.commands).toContain("session queue-add");
		expect(manifest.commands).toContain("chat archive");
		expect(manifest.commands).toContain("chat workspace");
		expect(manifest.contextOptions).toEqual([
			"--attach",
			"--file",
			"--transcript",
			"--plan",
		]);
		expect(manifest.deleteRequires).toBe("--confirm");
	});

	test("expands JSON input into the same repeatable flag contract", async () => {
		const argv = await __testing.expandInputJson([
			"session",
			"send",
			"--input-json",
			JSON.stringify({
				session: "s_1",
				file: ["a.ts", "b.ts"],
				permission: "plan",
			}),
		]);
		const parsed = __testing.parse(argv);
		expect(parsed.flags.get("session")).toEqual(["s_1"]);
		expect(parsed.flags.get("file")).toEqual(["a.ts", "b.ts"]);
		expect(parsed.flags.get("permission")).toEqual(["plan"]);
	});

	test("discovers the protected local dev RPC descriptor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-access-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:8788/rpc",
				token: "zt_development",
			}),
		);
		await expect(
			__testing.localCliAccess({ ZUSE_DEV_CLI_ACCESS_FILE: accessFile }),
		).resolves.toEqual({
			schemaVersion: 1,
			wsUrl: "ws://127.0.0.1:8788/rpc",
			token: "zt_development",
		});
	});

	test("discovers the protected installed desktop RPC descriptor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-user-data-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:47837/rpc",
				token: "zt_installed",
			}),
		);
		await expect(
			__testing.localCliAccess({ ZUSE_USER_DATA_DIR: directory }),
		).resolves.toEqual({
			schemaVersion: 1,
			wsUrl: "ws://127.0.0.1:47837/rpc",
			token: "zt_installed",
		});
		const endpoint = new URL(
			await __testing.endpoint(__testing.parse(["chat", "list"]), {
				ZUSE_USER_DATA_DIR: directory,
			}),
		);
		expect(endpoint.origin).toBe("ws://127.0.0.1:47837");
		expect(endpoint.pathname).toBe("/rpc");
		expect(endpoint.searchParams.get("token")).toBe("zt_installed");
	});

	test("negotiates the current wire protocol with local dev RPC", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-endpoint-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:8788/rpc",
				token: "zt_development",
			}),
		);
		const endpoint = new URL(
			await __testing.endpoint(__testing.parse(["computer", "list"]), {
				ZUSE_DEV_CLI_ACCESS_FILE: accessFile,
			}),
		);
		expect(endpoint.searchParams.get("wireVersion")).toBe(
			String(WIRE_PROTOCOL_VERSION),
		);
		expect(endpoint.searchParams.get("token")).toBe("zt_development");
	});

	test("explicit connection flags override a discovered descriptor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-explicit-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:4859/rpc",
				token: "descriptor-token",
			}),
		);
		const endpoint = new URL(
			await __testing.endpoint(
				__testing.parse([
					"computer",
					"list",
					"--ws-url",
					"wss://explicit.example/rpc",
					"--token",
					"explicit-token",
				]),
				{ ZUSE_USER_DATA_DIR: directory },
			),
		);
		expect(endpoint.origin).toBe("wss://explicit.example");
		expect(endpoint.searchParams.get("token")).toBe("explicit-token");
	});

	test("falls back to the desktop port when no valid descriptor exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-missing-"));
		await writeFile(join(directory, "cli-access.json"), "not-json");
		const endpoint = new URL(
			await __testing.endpoint(__testing.parse(["computer", "list"]), {
				ZUSE_USER_DATA_DIR: directory,
			}),
		);
		expect(endpoint.origin).toBe("ws://127.0.0.1:47837");
		expect(endpoint.searchParams.has("token")).toBe(false);
	});

	test("classifies refused sockets separately from stale credentials", async () => {
		await expect(
			__testing.socketOpenFailure(
				"ws://127.0.0.1:4859/rpc?token=secret",
				async () => {
					throw new Error("connection refused");
				},
			),
		).resolves.toMatchObject({ code: "server_unavailable" });
		await expect(
			__testing.socketOpenFailure(
				"ws://127.0.0.1:4859/rpc?token=secret",
				async () => new Response(null, { status: 401 }),
			),
		).resolves.toMatchObject({ code: "unauthorized" });
	});

	test("reports an actionable wire protocol mismatch", async () => {
		await expect(
			__testing.socketOpenFailure(
				`ws://127.0.0.1:4859/rpc?wireVersion=${WIRE_PROTOCOL_VERSION}&token=secret`,
				async (input) => {
					const url = new URL(String(input));
					if (url.pathname === "/rpc") {
						return Response.json(
							{ error: "wire_protocol_mismatch", expectedVersion: 4 },
							{ status: 426 },
						);
					}
					throw new Error("diagnostic endpoint should not be needed");
				},
			),
		).resolves.toMatchObject({
			code: "update_required",
			details: { clientVersion: WIRE_PROTOCOL_VERSION, serverVersion: 4 },
		});
	});
});

const connectionMocks = vi.hoisted(() => ({
	client: {} as Record<string, ReturnType<typeof vi.fn>>,
	dispose: vi.fn(async () => {}),
}));
vi.mock("@zuse/client-runtime/connection", () => ({
	makeRpcClientSession: vi.fn(async () => ({
		client: connectionMocks.client,
		dispose: connectionMocks.dispose,
	})),
}));

vi.mock("@zuse/client-runtime/ws-protocol", () => ({
	wsClientProtocolLayer: vi.fn(() => ({})),
}));

describe("cloud agent commands", () => {
	beforeEach(() => {
		for (const key of Object.keys(connectionMocks.client))
			delete connectionMocks.client[key];
		connectionMocks.dispose.mockClear();
	});
	const command = (args: string[]) =>
		__testing.execute(args, {
			ZUSE_WS_URL: "ws://localhost:47837/rpc",
			ZUSE_CLOUD_WORKSPACE_ID: "current",
		});
	test("help and invalid commands never open a connection", async () => {
		await expect(command(["workspace", "--help"])).resolves.toHaveProperty(
			"commands",
		);
		await expect(command(["workspace", "destroy"])).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(connectionMocks.dispose).not.toHaveBeenCalled();
	});
	test("publishes and revokes previews using the current workspace", async () => {
		const publish = vi.fn(() =>
			Effect.succeed({ url: "https://preview.test" }),
		);
		const revoke = vi.fn(() =>
			Effect.succeed({ workspaceId: "current", port: 8123 }),
		);
		connectionMocks.client["cloud.workspaces.previewUrl"] = publish;
		connectionMocks.client["cloud.workspaces.revokePreviewUrl"] = revoke;
		await expect(
			command(["preview", "set", "--port", "8123"]),
		).resolves.toEqual({ url: "https://preview.test" });
		expect(publish).toHaveBeenCalledWith({
			workspaceId: "current",
			port: 8123,
		});
		await command(["preview", "delete", "--port", "8123"]);
		expect(revoke).toHaveBeenCalledWith({ workspaceId: "current", port: 8123 });
		await command(["preview", "delete", "--all"]);
		expect(revoke).toHaveBeenLastCalledWith({
			workspaceId: "current",
			port: undefined,
		});
		expect(connectionMocks.dispose).toHaveBeenCalledTimes(3);
	});
	test("invalid ports and accidental revoke-all requests do not mutate", async () => {
		for (const port of ["0", "65536", "1.5", "nope"])
			await expect(
				command(["preview", "set", "--port", port]),
			).rejects.toMatchObject({ code: "invalid_input" });
		await expect(command(["preview", "delete"])).rejects.toMatchObject({
			code: "invalid_input",
		});
	});
	test("creation infers a unique project and provider and preserves retry identity", async () => {
		connectionMocks.client["cloud.projects.list"] = vi.fn(() =>
			Effect.succeed({
				projects: [{ projectId: "project", defaultBranch: "main" }],
			}),
		);
		connectionMocks.client["cloud.providers"] = vi.fn(() =>
			Effect.succeed({ providers: [{ providerId: "boxd" }] }),
		);
		const create = vi.fn(() =>
			Effect.succeed({ workspace: { workspaceId: "new" } }),
		);
		connectionMocks.client["cloud.workspaces.create"] = create;
		await command([
			"workspace",
			"create",
			"--prompt",
			"Review",
			"--idempotency-key",
			"stable",
		]);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project",
				providerId: "boxd",
				baseRef: "main",
				firstMessage: "Review",
				idempotencyKey: "stable",
				runtimeMode: "approval-required",
			}),
		);
	});
	test("failed preview revocation is not reported as success and closes the connection", async () => {
		connectionMocks.client["cloud.workspaces.revokePreviewUrl"] = vi.fn(() =>
			Effect.fail(new Error("provider unavailable")),
		);
		await expect(
			command(["preview", "delete", "--port", "8123"]),
		).rejects.toThrow("provider unavailable");
		expect(connectionMocks.dispose).toHaveBeenCalledOnce();
	});
	test("keeps the connection open until preview discovery completes", async () => {
		connectionMocks.client["previews.listServers"] = vi.fn(() =>
			Effect.promise(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(connectionMocks.dispose).not.toHaveBeenCalled();
				return { servers: [] };
			}),
		);
		await expect(command(["preview", "list"])).resolves.toEqual({
			servers: [],
		});
		expect(connectionMocks.dispose).toHaveBeenCalledOnce();
	});
	test("workspace deletion requires confirmation", async () => {
		const remove = vi.fn(() => Effect.succeed({ workspaceId: "other" }));
		connectionMocks.client["cloud.workspaces.delete"] = remove;
		await expect(
			command(["workspace", "delete", "other"]),
		).rejects.toMatchObject({ code: "confirmation_required" });
		expect(remove).not.toHaveBeenCalled();
		await command([
			"workspace",
			"delete",
			"other",
			"--confirm",
			"--idempotency-key",
			"delete-1",
		]);
		expect(remove).toHaveBeenCalledWith({
			workspaceId: "other",
			commandId: "delete-1",
		});
	});
	test("discovers runtime access and refreshed credentials through ZUSE_USER_DATA", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cloud-cli-"));
		const file = join(directory, "cli-access.json");
		for (const token of ["first", "renewed"]) {
			await writeFile(
				file,
				JSON.stringify({
					schemaVersion: 1,
					wsUrl: "ws://localhost:47837/rpc",
					token,
					cloudWorkspaceId: "current",
				}),
			);
			const url = new URL(
				await __testing.endpoint(__testing.parse(["session", "list"]), {
					ZUSE_USER_DATA: directory,
				}),
			);
			expect(url.searchParams.get("token")).toBe(token);
		}
	});
	test("remote tabs use a gateway ticket and never send it in the URL", async () => {
		connectionMocks.client["cloud.workspaces.connect"] = vi.fn(() =>
			Effect.succeed({
				wsUrl: "wss://api.test/gateway",
				protocol: "zuse-workspace-v2",
				credential: "ticket",
			}),
		);
		connectionMocks.client["workspace.list"] = vi.fn(() =>
			Effect.succeed([{ id: "project", path: "/repo", name: "Repo" }]),
		);
		connectionMocks.client["session.list"] = vi.fn(() => Effect.succeed([]));
		await command(["session", "list", "--cloud-workspace", "sibling"]);
		expect(
			connectionMocks.client["cloud.workspaces.connect"],
		).toHaveBeenCalledWith({ workspaceId: "sibling" });
		expect(wsClientProtocolLayer).toHaveBeenLastCalledWith(
			"wss://api.test/gateway",
			{ protocols: ["zuse-workspace-v2", "ticket"] },
		);
		expect(connectionMocks.dispose).toHaveBeenCalledTimes(2);
	});
	test("renames the cloud workspace's actual sidebar chat", async () => {
		connectionMocks.client["cloud.workspaces.get"] = vi.fn(() =>
			Effect.succeed({ chatId: "cloud-chat" }),
		);
		connectionMocks.client["cloud.workspaces.connect"] = vi.fn(() =>
			Effect.succeed({
				wsUrl: "wss://api.test/gateway",
				protocol: "zuse-workspace-v2",
				credential: "ticket",
			}),
		);
		const rename = vi.fn(() =>
			Effect.succeed({ id: "cloud-chat", title: "Review" }),
		);
		connectionMocks.client["chat.rename"] = rename;
		await command(["workspace", "rename", "sibling", "--title", "Review"]);
		expect(rename).toHaveBeenCalledWith({
			chatId: "cloud-chat",
			title: "Review",
		});
	});
	test("preserves equals signs in inline prompt options", () => {
		expect(
			__testing
				.parse(["session", "send", "--message=a=b=c"])
				.flags.get("message"),
		).toEqual(["a=b=c"]);
	});
});
