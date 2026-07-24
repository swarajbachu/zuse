import { Effect, Stream } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	hydrateMessages,
	refreshMessages,
	resetMessagesRuntime,
} from "../../../src/store/messages";

const runtime = vi.hoisted(() => ({
	appStateListener: undefined as
		| ((state: "active" | "background" | "inactive") => void)
		| undefined,
	clientRequests: 0,
	streamFails: false,
	streamCompletes: false,
	reportedFailures: 0,
}));

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: vi.fn(
			(
				_event: string,
				listener: (state: "active" | "background" | "inactive") => void,
			) => {
				runtime.appStateListener = listener;
				return { remove: vi.fn() };
			},
		),
	},
}));

vi.mock("~/offline/cache", () => ({
	readMessagesSnapshot: () => Effect.succeed(null),
	writeMessagesSnapshot: () => Effect.void,
}));

vi.mock("~/rpc/connection", () => ({
	getConnectionClient: () =>
		Effect.sync(() => {
			runtime.clientRequests += 1;
			return {
				"messages.list": () => Effect.succeed([]),
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

	test("restarts retained message streams when the app becomes active", async () => {
		await hydrateMessages("conn", options, sessionId);
		expect(runtime.clientRequests).toBe(1);

		runtime.appStateListener?.("background");
		await Promise.resolve();
		runtime.appStateListener?.("active");
		await vi.waitFor(() => expect(runtime.clientRequests).toBe(2));
	});

	test("a failed stream does not block the next hydration", async () => {
		runtime.streamFails = true;
		await hydrateMessages("conn", options, sessionId);
		await Promise.resolve();

		runtime.streamFails = false;
		await vi.waitFor(async () => {
			await hydrateMessages("conn", options, sessionId);
			expect(runtime.clientRequests).toBe(2);
		});
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

	test("an explicit refresh replaces a warm transcript stream", async () => {
		await hydrateMessages("conn", options, sessionId);
		expect(runtime.clientRequests).toBe(1);

		await refreshMessages("conn", options, sessionId);

		expect(runtime.clientRequests).toBe(2);
		expect(runtime.reportedFailures).toBe(0);
	});
});
