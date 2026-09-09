import {
	ClientBus,
	type ResourceDriverContext,
} from "@zuse/client-runtime/client-bus";
import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import {
	ChatId,
	EnvironmentId,
	type Session,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { countLocalActiveAgents } from "../../src/lib/local-agent-activity.ts";

const local = {
	id: SessionId.make("local"),
	chatId: ChatId.make("local-chat"),
	status: "running" as const,
};
const input = {
	connection: "connected",
	sync: "live" as const,
	sessions: [local],
	cloudChatIds: new Set<string>(),
};
describe("confirmed local agent activity", () => {
	it("reports unknown for disconnected and cached state instead of stale running counts", () => {
		expect(
			countLocalActiveAgents({ ...input, connection: "disconnected" }),
		).toBeNull();
		expect(countLocalActiveAgents({ ...input, sync: "cached" })).toBeNull();
	});
	it("uses current idle status even if an old transcript still says running", () => {
		expect(
			countLocalActiveAgents({
				...input,
				sessions: [{ ...local, status: "idle" }],
			}),
		).toBe(0);
	});
	it("excludes cloud placeholders and counts each local running session once", () => {
		const cloud = {
			...local,
			id: SessionId.make("cloud"),
			chatId: ChatId.make("cloud-chat"),
		};
		expect(
			countLocalActiveAgents({
				...input,
				sessions: [local, local, cloud],
				cloudChatIds: new Set([cloud.chatId]),
			}),
		).toBe(1);
	});
});

it("keeps the live running count through an empty checkpoint, then clears it on idle", async () => {
	type Sessions = Pick<Session, "id" | "chatId" | "status">[];
	const key = makeResourceKey<Sessions>("environment-shell", {
		environmentId: EnvironmentId.make("local-test"),
	});
	let resolveCheckpoint!: (value: null) => void;
	const checkpoint = new Promise<null>((resolve) => {
		resolveCheckpoint = resolve;
	});
	let stream: ResourceDriverContext<object, Sessions> | undefined;
	const bus = new ClientBus<object>({
		resolver: {
			resolve: () =>
				Effect.succeed({ client: {}, dispose: async () => undefined }),
		},
		synchronizer: { synchronize: () => checkpoint },
		driverFor: () => ({
			start: (context) => {
				stream = context as ResourceDriverContext<object, Sessions>;
				stream.emit({
					data: [local],
					sync: "live",
					cursor: { epoch: "session-stream", version: 1 },
				});
			},
			stop: () => undefined,
		}),
	});
	const lease = bus.retain(key, { activation: "connect" });
	const count = () => {
		const view = bus.snapshot(key);
		return countLocalActiveAgents({
			connection: view.connection,
			sync: view.sync,
			sessions: view.data ?? [],
			cloudChatIds: new Set(),
		});
	};
	await vi.waitFor(() => expect(count()).toBe(1));
	resolveCheckpoint(null);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(count()).toBe(1);
	stream?.emit({
		data: [{ ...local, status: "idle" }],
		sync: "live",
		cursor: { epoch: "session-stream", version: 2 },
	});
	expect(count()).toBe(0);
	lease.release();
	await bus.dispose();
});
