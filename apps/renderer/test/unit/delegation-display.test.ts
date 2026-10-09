import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	delegationDetail,
	delegationElapsedMs,
	delegationGroupTiming,
	formatElapsed,
	groupDelegations,
	spawnDelegationMember,
	spawnDelegationView,
	summarizeDelegationStatuses,
} from "../../src/lib/delegation-display.ts";
import { groupMessages } from "../../src/lib/group-messages.ts";

const sessionId = "session-delegation" as SessionId;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 9, 0, 0, seconds));

function message(
	id: string,
	content: Message["content"],
	createdAt = at(0),
): Message {
	return { id, sessionId, role: "assistant", content, createdAt } as Message;
}

const spawnUse = (id: string, input: Record<string, unknown> = {}) =>
	message(id, {
		_tag: "tool_use",
		itemId: id,
		tool: "mcp__zuse-orchestration__create_thread",
		input: { task: "Do the work", ...input },
	} as Message["content"]);

const spawnResult = (id: string, output: unknown, isError = false) =>
	message(`${id}-result`, {
		_tag: "tool_result",
		itemId: id,
		output: JSON.stringify(output),
		isError,
	} as Message["content"]);

const agentUse = (id: string) =>
	message(id, {
		_tag: "tool_use",
		itemId: id,
		tool: "Agent",
		input: { description: `Audit ${id}`, prompt: "Inspect" },
	} as Message["content"]);

describe("delegation display", () => {
	it("formats elapsed time compactly", () => {
		expect(formatElapsed(45_900)).toBe("45s");
		expect(formatElapsed(510_000)).toBe("8m 30s");
		expect(formatElapsed(3_900_000)).toBe("1h 05m");
		expect(formatElapsed(-5)).toBe("0s");
	});

	it("summarizes statuses in reading order, omitting zero counts", () => {
		expect(
			summarizeDelegationStatuses(["done", "working", "failed", "working"]),
		).toEqual([
			{ status: "working", count: 2 },
			{ status: "done", count: 1 },
			{ status: "failed", count: 1 },
		]);
	});

	it("spans a group from first start to last settle, withholding unknown ends", () => {
		const settled = delegationGroupTiming([
			{ status: "done", startedAt: 10, completedAt: 50 },
			{ status: "failed", startedAt: 5, completedAt: 30 },
		]);
		expect(settled).toEqual({ status: "done", startedAt: 5, completedAt: 50 });
		expect(delegationElapsedMs(settled, 0)).toBe(45);

		const unknownEnd = delegationGroupTiming([
			{ status: "done", startedAt: 10, completedAt: 50 },
			{ status: "done", startedAt: 5, completedAt: null },
		]);
		expect(unknownEnd.completedAt).toBeNull();
		expect(delegationElapsedMs(unknownEnd, 1_000)).toBeNull();

		const live = delegationGroupTiming([
			{ status: "working", startedAt: 10, completedAt: null },
			{ status: "done", startedAt: 5, completedAt: 20 },
		]);
		expect(live.status).toBe("working");
		expect(delegationElapsedMs(live, 105)).toBe(100);
	});

	it("flattens markdown into one capped line", () => {
		expect(
			delegationDetail("## Done\n- Moved [site](https://x.y) to `apps/web`\n"),
		).toBe("Done Moved site to apps/web");
		expect(delegationDetail("   ")).toBeNull();
		expect(delegationDetail("x".repeat(300))?.length).toBe(281);
	});

	it("keeps failed and follow-up orchestration calls as ordinary tools", () => {
		const content = (tool: string) =>
			({ _tag: "tool_use", itemId: "a", tool, input: {} }) as Extract<
				Message["content"],
				{ _tag: "tool_use" }
			>;
		const create = content("mcp__zuse-orchestration__create_thread");
		expect(spawnDelegationMember("a", create, at(0), undefined)).not.toBeNull();
		expect(
			spawnDelegationMember("a", create, at(0), {
				output: "boom",
				isError: true,
			}),
		).toBeNull();
		expect(
			spawnDelegationMember(
				"a",
				content("mcp__zuse-orchestration__send_to_thread"),
				at(0),
				undefined,
			),
		).toBeNull();
	});

	it("groups adjacent spawns and subagents, absorbing spawn results", () => {
		const messages = [
			message("text", { _tag: "assistant", text: "Delegating." }),
			spawnUse("one"),
			spawnUse("two"),
			message("status", { _tag: "context_usage" } as Message["content"]),
			spawnResult("one", { chatId: "chat-1", sessionId: "s-1", title: "A" }),
			spawnResult("two", { chatId: "chat-2", sessionId: "s-2", title: "B" }),
			agentUse("agent"),
			message("after", { _tag: "assistant", text: "Waiting." }),
		];
		const groups = groupDelegations(groupMessages(messages));
		expect(groups.map((group) => group.kind)).toEqual([
			"single",
			"delegation",
			"single",
			"single",
		]);
		const fleet = groups[1];
		expect(fleet?.kind === "delegation" && fleet.id).toBe("delegation:one");
		expect(
			fleet?.kind === "delegation" &&
				fleet.members.map((member) => `${member.kind}:${member.id}`),
		).toEqual(["spawn:one", "spawn:two", "subagent:agent"]);
	});

	it("derives an orchestrated chat's state from its session", () => {
		const [group] = groupDelegations(
			groupMessages([
				spawnUse("one", { providerId: "codex" }),
				spawnResult("one", {
					chatId: "chat-1",
					sessionId: "s-1",
					title: "Site",
				}),
			]),
		);
		if (group?.kind !== "delegation" || group.members[0]?.kind !== "spawn") {
			throw new Error("expected a spawn member");
		}
		const member = group.members[0];
		const unloaded = spawnDelegationView(member, {
			fallbackProviderId: "claude",
			session: null,
		});
		expect(unloaded).toMatchObject({
			title: "Site",
			providerId: "codex",
			status: "working",
			completedAt: null,
			open: null,
		});
		const running = spawnDelegationView(member, {
			fallbackProviderId: "claude",
			session: {
				providerId: "gemini",
				status: "running",
				runtime: "running",
				messages: [
					message("reply", { _tag: "assistant", text: "Migrating **pages**" }),
				],
			},
		});
		expect(running).toMatchObject({
			providerId: "gemini",
			status: "working",
			detail: "Migrating **pages**",
			completedAt: null,
			open: { kind: "chat", chatId: "chat-1", sessionId: "s-1" },
		});
		const failed = spawnDelegationView(member, {
			fallbackProviderId: "claude",
			session: {
				providerId: "gemini",
				status: "error",
				runtime: "idle",
				messages: [message("reply", { _tag: "assistant", text: "x" }, at(9))],
			},
		});
		expect(failed.status).toBe("failed");
		expect(failed.completedAt).toBe(at(9).getTime());
	});
});
