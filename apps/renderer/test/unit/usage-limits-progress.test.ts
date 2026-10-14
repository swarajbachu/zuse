import { ClientBus } from "@zuse/client-runtime/client-bus";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { environmentShellResourceKey } from "../../src/lib/environment-shell-client-bus.ts";
import type { MemoizeClient } from "../../src/lib/rpc-client.ts";
import { useUsageLimitsStore } from "../../src/store/usage-limits.ts";

const runtime = vi.hoisted(() => ({
	bus: null as ClientBus<MemoizeClient> | null,
}));
vi.mock(
	"../../src/lib/session-timeline-client-bus.ts",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../src/lib/session-timeline-client-bus.ts")
			>();
		return { ...actual, getRendererClientBus: () => runtime.bus };
	},
);

it("publishes fast limits through the real transport while a provider and workspace action are pending", async () => {
	const provider = (providerId: "claude" | "codex") => ({
		providerId,
		planLabel: "Pro",
		windows: [],
		creditsRemaining: 25,
		fetchedAt: new Date().toISOString(),
		source: "api" as const,
	});
	let finish!: () => void;
	const slow = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const requests: string[] = [];
	const client = {
		"usage.limits": (payload: { providerId?: string }) =>
			Effect.promise(async () => {
				requests.push(payload.providerId ?? "all");
				if (payload.providerId === "claude")
					return { providers: [provider("claude")] };
				await slow;
				return {
					providers: payload.providerId === "codex" ? [provider("codex")] : [],
				};
			}),
	} as unknown as MemoizeClient;
	const execute = vi.fn(async (_client, command) => {
		await slow;
		return {
			commandId: command.commandId,
			receivedAt: Date.now(),
			result: null,
		};
	});
	const bus = new ClientBus<MemoizeClient>({
		resolver: {
			resolve: () => Effect.succeed({ client, dispose: async () => undefined }),
		},
		commandExecutor: { execute },
	});
	runtime.bus = bus;
	const environmentId = EnvironmentId.make("local");
	const action = bus.dispatch({
		kind: "workspace.action",
		commandId: CommandId.make("slow-action"),
		environmentId,
		resource: environmentShellResourceKey({ environmentId }),
		payload: {},
		retry: "never",
		createdAt: Date.now(),
	});
	await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
	useUsageLimitsStore.setState({
		providers: [],
		history: [],
		loading: false,
		loadingProviders: [],
		error: null,
		lastLoadedAt: null,
	});
	const pending = useUsageLimitsStore.getState().load();
	try {
		await vi.waitFor(() => {
			expect(requests).toHaveLength(5);
			expect(
				useUsageLimitsStore
					.getState()
					.providers.some((p) => p.providerId === "claude"),
			).toBe(true);
		});
		expect(useUsageLimitsStore.getState().loading).toBe(true);
		expect(useUsageLimitsStore.getState().loadingProviders).not.toContain(
			"claude",
		);
		expect(execute).toHaveBeenCalledOnce();
	} finally {
		finish();
		await Promise.all([pending, action]);
		await bus.dispose();
	}
});
