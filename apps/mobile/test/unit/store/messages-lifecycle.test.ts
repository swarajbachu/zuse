import { Effect, Stream } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	hydrateMessages,
	refreshMessages,
	resetMessagesRuntime,
} from "../../../src/store/messages";

const runtime = vi.hoisted(() => ({
	clientRequests: 0,
	streamFails: false,
	streamCompletes: false,
	reportedFailures: 0,
}));

vi.mock("~/offline/cache", () => ({
	deletePath: () => Effect.void,
	messagesPath: () => "/messages/session.json",
	readClientCommandOutbox: () => Effect.succeed({ entries: [], receipts: [] }),
	readMessagesSnapshot: () => Effect.succeed(null),
	writeClientCommandOutbox: () => Effect.void,
	writeMessagesSnapshot: () => Effect.void,
}));

vi.mock("~/rpc/connection", () => ({
	isConnectionOnline: () => true,
	getConnectionClient: () =>
		Effect.sync(() => {
			runtime.clientRequests += 1;
			return {
				"session.events": () =>
					runtime.streamFails
						? Stream.fail(new Error("stream disconnected"))
						: runtime.streamCompletes
							? Stream.empty
							: Stream.never,
			};
		}),
	reportConnectionFailure: () => {
		runtime.reportedFailures += 1;
	},
}));

const options = { host: "127.0.0.1", port: 4000, token: null } as never;
const sessionId = "session-1" as never;

describe("message stream lifecycle", () => {
	beforeEach(async () => {
		await resetMessagesRuntime();
		runtime.clientRequests = 0;
		runtime.streamFails = false;
		runtime.streamCompletes = false;
		runtime.reportedFailures = 0;
	});

	test("shares one retained stream across duplicate hydrations", async () => {
		await hydrateMessages("conn", options, sessionId);
		await hydrateMessages("conn", options, sessionId);
		expect(runtime.clientRequests).toBe(1);
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
});
