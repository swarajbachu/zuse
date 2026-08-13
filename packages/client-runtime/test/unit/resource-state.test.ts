import {
	ChatId,
	EnvironmentId,
	FolderId,
	PtyId,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	makeResourceKey,
	resourceKeyId,
	resourceRefKey,
} from "../../src/resource-ref.ts";
import {
	deriveSurfacePhase,
	emptyResourceView,
	type ResourceView,
} from "../../src/resource-state.ts";

const environmentId = EnvironmentId.make("environment:a");

describe("environment-qualified resource references", () => {
	it("includes environment identity and escapes identifier delimiters", () => {
		const first = makeResourceKey<{ title: string }>("session-timeline", {
			environmentId,
			sessionId: SessionId.make("session:a"),
		});
		const second = makeResourceKey<{ title: string }>("session-timeline", {
			environmentId: EnvironmentId.make("environment"),
			sessionId: SessionId.make("a:session:a"),
		});

		expect(resourceKeyId(first)).not.toBe(resourceKeyId(second));
		expect(resourceKeyId(first)).toContain("environment%3Aa");
	});

	it("distinguishes every qualified reference shape", () => {
		const references = [
			{ environmentId },
			{ environmentId, projectId: FolderId.make("project") },
			{ environmentId, chatId: ChatId.make("chat") },
			{ environmentId, sessionId: SessionId.make("session") },
			{
				environmentId,
				folderId: FolderId.make("project"),
				worktreeId: null,
				rootPath: "/repo",
			},
			{
				environmentId,
				folderId: FolderId.make("project"),
				worktreeId: WorktreeId.make("worktree"),
				rootPath: "/repo",
			},
			{ environmentId, terminalId: PtyId.make("terminal") },
		];

		expect(new Set(references.map(resourceRefKey)).size).toBe(
			references.length,
		);
	});
});

describe("deriveSurfacePhase", () => {
	const withData = <Data>(
		patch: Partial<ResourceView<Data>> = {},
	): ResourceView<Data> => ({
		...emptyResourceView<Data>(),
		data: {} as Data,
		origin: "cache",
		sync: "cached",
		...patch,
	});

	it("shows a loader only while no usable data exists", () => {
		expect(deriveSurfacePhase(emptyResourceView())).toBe("initial-loading");
		expect(
			deriveSurfacePhase(withData({ connection: "offline", sync: "failed" })),
		).toBe("offline-stale");
	});

	it("uses one state mapping across waking, sync, and auth failures", () => {
		expect(deriveSurfacePhase(withData({ connection: "waking" }))).toBe(
			"waking",
		);
		expect(
			deriveSurfacePhase(
				withData({ connection: "connected", sync: "synchronizing" }),
			),
		).toBe("synchronizing");
		expect(deriveSurfacePhase(withData({ connection: "blocked-auth" }))).toBe(
			"blocked-auth",
		);
		expect(
			deriveSurfacePhase(withData({ connection: "update-required" })),
		).toBe("update-required");
	});

	it("reports live only for a connected synchronized resource", () => {
		expect(
			deriveSurfacePhase(
				withData({ origin: "runtime", connection: "connected", sync: "live" }),
			),
		).toBe("live");
	});
});
