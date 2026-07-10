import { describe, expect, test } from "vitest";
import type { SessionCommand } from "../core/commands.js";
import { DispatchEngine, InMemoryDispatchStorage } from "./dispatch.js";

const create: SessionCommand = {
	_tag: "CreateSession",
	sessionId: "session-1",
	chatId: "chat-1",
	projectId: "project-1",
	createdAt: 1,
};

describe("DispatchEngine", () => {
	test("returns the original receipt when a command is re-dispatched", async () => {
		const storage = new InMemoryDispatchStorage();
		let nextId = 0;
		const engine = new DispatchEngine(storage, () => `event-${++nextId}`);

		const first = await engine.dispatch({
			commandId: "command-1",
			streamId: "session-1",
			command: create,
		});
		const replay = await engine.dispatch({
			commandId: "command-1",
			streamId: "session-1",
			command: create,
		});

		expect(replay).toEqual(first);
		expect(first.eventIds).toEqual(["event-1"]);
		expect(storage.eventsFor("session-1")).toHaveLength(1);
	});

	test("serializes every distinct concurrent command on one stream", async () => {
		const storage = new InMemoryDispatchStorage();
		let nextId = 0;
		const engine = new DispatchEngine(storage, () => `event-${++nextId}`);

		const created = engine.dispatch({
			commandId: "command-create",
			streamId: "session-1",
			command: create,
		});
		const titled = engine.dispatch({
			commandId: "command-title",
			streamId: "session-1",
			command: { _tag: "SetTitle", title: "Renamed" },
		});
		const retitled = engine.dispatch({
			commandId: "command-retitle",
			streamId: "session-1",
			command: { _tag: "SetTitle", title: "Renamed again" },
		});

		const [createReceipt, titleReceipt, retitleReceipt] = await Promise.all([
			created,
			titled,
			retitled,
		]);
		expect(createReceipt.streamVersion).toBe(1);
		expect(titleReceipt.streamVersion).toBe(2);
		expect(retitleReceipt.streamVersion).toBe(3);
		expect(
			storage.eventsFor("session-1").map((event) => event.event._tag),
		).toEqual(["SessionCreated", "SessionTitleSet", "SessionTitleSet"]);
	});

	test("does not append events when the decider rejects a command", async () => {
		const storage = new InMemoryDispatchStorage();
		const engine = new DispatchEngine(storage, () => "unused");
		await expect(
			engine.dispatch({
				commandId: "command-title",
				streamId: "missing",
				command: { _tag: "SetTitle", title: "No session" },
			}),
		).rejects.toMatchObject({ _tag: "SessionNotFound" });
		expect(storage.eventsFor("missing")).toEqual([]);
	});

	test("records correlation and causation metadata on emitted events", async () => {
		const storage = new InMemoryDispatchStorage();
		const engine = new DispatchEngine(storage, () => "event-1");

		await engine.dispatch({
			commandId: "reactor:event-0:0",
			streamId: "session-1",
			correlationId: "request-1",
			causationEventId: "event-0",
			command: create,
		});

		expect(storage.eventsFor("session-1")[0]).toMatchObject({
			correlationId: "request-1",
			causationEventId: "event-0",
		});
	});
});
