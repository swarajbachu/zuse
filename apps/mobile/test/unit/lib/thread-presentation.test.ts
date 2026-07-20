import type { Chat, Session } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	hasRunningChatThread,
	nearestSurvivingThread,
	threadDisplayTitle,
	threadStatusLabel,
} from "../../../src/lib/thread-presentation";

const chat = { title: "Reconnect" } as Chat;

describe("mobile thread presentation", () => {
	it("uses stable ordinal labels when the session repeats the chat title", () => {
		const session = {
			title: "Reconnect",
			permissionMode: "default",
		} as Session;
		expect(threadDisplayTitle(session, chat, 2)).toBe("Thread 3");
	});

	it("gives planning and explicit thread titles useful identities", () => {
		expect(
			threadDisplayTitle(
				{ title: "Reconnect", permissionMode: "plan" } as Session,
				chat,
				0,
			),
		).toBe("Planning");
		expect(
			threadDisplayTitle(
				{ title: "Build", permissionMode: "default" } as Session,
				chat,
				1,
			),
		).toBe("Build");
	});

	it("maps runtime states to stable human labels", () => {
		expect(threadStatusLabel("booting")).toBe("Starting");
		expect(threadStatusLabel("running")).toBe("Running");
		expect(threadStatusLabel("error")).toBe("Error");
	});

	it("only reports concurrency for an actually running sibling", () => {
		const threads = [
			{ id: "one", status: "idle" },
			{ id: "two", status: "idle" },
		] as Session[];
		expect(hasRunningChatThread(threads, (thread) => thread.status)).toBe(
			false,
		);
		expect(
			hasRunningChatThread(threads, (thread) =>
				thread.id === "two" ? "running" : thread.status,
			),
		).toBe(true);
	});

	it("selects the next thread, then the previous one, after archive", () => {
		const threads = [
			{ id: "one" },
			{ id: "two" },
			{ id: "three" },
		] as Session[];
		const second = threads[1];
		const third = threads[2];
		if (second === undefined || third === undefined)
			throw new Error("Expected thread fixtures");
		expect(nearestSurvivingThread(threads, second.id)?.id).toBe("three");
		expect(nearestSurvivingThread(threads, third.id)?.id).toBe("two");
	});
});
