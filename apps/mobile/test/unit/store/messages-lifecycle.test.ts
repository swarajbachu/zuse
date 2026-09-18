import { Effect, Stream } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { connectionSessionKey } from "../../../src/lib/session-key";
import {
	hydrateMessages,
	refreshMessages,
	resetMessagesRuntime,
	sessionTranscriptReadyAtom,
} from "../../../src/store/messages";
import {
	mobileClientBus,
	registerMobileEnvironment,
	retryMobileClientBusConnections,
	sessionTimelineKey,
} from "../../../src/store/mobile-client-bus";
import { appAtomRegistry } from "../../../src/store/registry";

const runtime = vi.hoisted(() => ({
	clientRequests: 0,
	eventInputs: [] as { historyMode?: string }[],
	streamFails: false,
	streamCompletes: false,
	reportedFailures: 0,
	ports: [] as number[],
	cached: null as unknown,
}));

vi.mock("~/offline/cache", () => ({
	deletePath: () => Effect.void,
	messagesPath: () => "/messages/session.json",
	readClientCommandOutbox: () => Effect.succeed({ entries: [], receipts: [] }),
	readMessagesSnapshot: () => Effect.succeed(runtime.cached),
	writeClientCommandOutbox: () => Effect.void,
	writeMessagesSnapshot: () => Effect.void,
}));

vi.mock("~/rpc/connection", () => ({
	isConnectionOnline: () => true,
	getConnectionClient: (options: { port: number }) =>
		Effect.sync(() => {
			runtime.ports.push(options.port);
			runtime.clientRequests += 1;
			return {
				"session.events": (input: { historyMode?: string }) => {
					runtime.eventInputs.push(input);
					return runtime.streamFails
						? Stream.fail(new Error("stream disconnected"))
						: runtime.streamCompletes
							? Stream.empty
							: Stream.never;
				},
			};
		}),
	reportConnectionFailure: () => {
		runtime.reportedFailures += 1;
	},
}));

const options = { host: "127.0.0.1", port: 4000, token: null } as never;
const sessionId = "session-1" as never;

describe("message stream lifecycle", () => {
	test("resume replaces a retained client even when its suspended stream never fails", async () => {
		await hydrateMessages("conn", options, sessionId);
		await vi.waitFor(() => expect(runtime.clientRequests).toBe(1));
		await vi.waitFor(() =>
			expect(mobileClientBus().connection("conn" as never).phase).toBe(
				"connected",
			),
		);
		retryMobileClientBusConnections();
		await vi.waitFor(() => expect(runtime.clientRequests).toBe(2));
	});
	beforeEach(async () => {
		await resetMessagesRuntime();
		runtime.clientRequests = 0;
		runtime.eventInputs = [];
		runtime.streamFails = false;
		runtime.streamCompletes = false;
		runtime.reportedFailures = 0;
		runtime.ports = [];
		runtime.cached = null;
	});

	test("shares one retained stream across duplicate hydrations", async () => {
		await hydrateMessages("conn", options, sessionId);
		await hydrateMessages("conn", options, sessionId);
		expect(runtime.clientRequests).toBe(1);
	});
	test("subscription startup does not mark a missing transcript ready", async () => {
		await hydrateMessages("conn", options, sessionId);
		expect(
			appAtomRegistry.get(
				sessionTranscriptReadyAtom(connectionSessionKey("conn", sessionId)),
			),
		).toBe(false);
	});
	test("a persisted empty transcript is ready without waiting for the network", async () => {
		runtime.cached = {
			cursor: { epoch: "test", version: 1 },
			savedAt: Date.now(),
			projection: {
				messages: [],
				currentTurn: null,
				queue: { items: [], paused: false },
				olderMessageSequence: null,
			},
		};
		await hydrateMessages("conn", options, sessionId);
		await vi.waitFor(() =>
			expect(
				appAtomRegistry.get(
					sessionTranscriptReadyAtom(connectionSessionKey("conn", sessionId)),
				),
			).toBe(true),
		);
	});

	test("a failed stream reports the connection fault", async () => {
		runtime.streamFails = true;
		await hydrateMessages("conn", options, sessionId);
		await vi.waitFor(() => expect(runtime.reportedFailures).toBe(1));
	});

	test("an unexpectedly completed stream reports failure and can reconnect", async () => {
		runtime.streamCompletes = true;
		await hydrateMessages("conn", options, sessionId);
		await vi.waitFor(() => expect(runtime.reportedFailures).toBe(1));

		runtime.streamCompletes = false;
		await vi.waitFor(async () => {
			await hydrateMessages("conn", options, sessionId);
			expect(runtime.clientRequests).toBe(2);
		});
	});

	test("an explicit refresh is owned by the ClientBus connection runtime", async () => {
		await hydrateMessages("conn", options, sessionId);
		expect(runtime.clientRequests).toBe(1);

		await refreshMessages("conn", options, sessionId);

		expect(runtime.clientRequests).toBe(1);
	});
	test("refreshing a retained transcript uses the replacement route", async () => {
		await hydrateMessages("conn", options, sessionId);
		await vi.waitFor(() =>
			expect(mobileClientBus().connection("conn" as never).phase).toBe(
				"connected",
			),
		);
		await refreshMessages(
			"conn",
			{ host: "127.0.0.1", port: 5000, token: null },
			sessionId,
		);
		await vi.waitFor(() => expect(runtime.ports.at(-1)).toBe(5000));
	});
});

vi.mock("~/rpc/api-client", () => ({
	cloudControlClient: {
		"cloud.transcript.get": () => Effect.succeed({ checkpoint: null }),
	},
}));

test.each([
	"boat",
	"e2b",
])("%s cloud opts into recent-first streaming", async (provider) => {
	const environmentId = registerMobileEnvironment(provider, {
		host: "localhost",
		port: 4000,
		token: null,
		cloudWorkspaceId: `workspace-${provider}`,
	});
	const lease = mobileClientBus().retain(
		sessionTimelineKey(environmentId, sessionId),
		{ activation: "connect" },
	);
	try {
		await vi.waitFor(() =>
			expect(runtime.eventInputs.at(-1)?.historyMode).toBe("background"),
		);
	} finally {
		lease.release();
		await resetMessagesRuntime();
	}
});

test("desktop-to-mobile streams opt into recent-first history", async () => {
	runtime.eventInputs = [];
	await hydrateMessages("local-history", options, sessionId);
	await vi.waitFor(() => expect(runtime.eventInputs.length).toBeGreaterThan(0));
	expect(runtime.eventInputs.at(-1)?.historyMode).toBe("background");
	await resetMessagesRuntime();
});

test("opening paused cloud history does not request a sandbox connection", async () => {
	await resetMessagesRuntime();
	const before = runtime.clientRequests;
	await hydrateMessages(
		"paused-cloud",
		{
			host: "localhost",
			port: 4000,
			token: null,
			cloudWorkspaceId: "paused-workspace",
		},
		sessionId,
	);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(runtime.clientRequests).toBe(before);
	await resetMessagesRuntime();
});
