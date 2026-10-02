import type { ChatSharingPolicy } from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatSharingOptions } from "../../../src/components/chat-sharing-options";
import type { SelectorRow } from "../../../src/components/selector-row";
import { SessionActionsMenu } from "../../../src/components/session-actions-menu";

const state = vi.hoisted(() => ({
	rows: [] as Array<Parameters<typeof SelectorRow>[0]>,
}));
vi.mock("~/components/selector-row", () => ({
	SelectorRow: (props: Parameters<typeof SelectorRow>[0]) => {
		state.rows.push(props);
		return null;
	},
}));
const policy: ChatSharingPolicy = {
	audience: "private",
	permission: "view",
	creatorSubject: "user-a",
	creatorMembershipId: "member-a",
	grants: [{ membershipId: "member-b", permission: "edit" }],
};
describe("shared mobile sharing controls", () => {
	beforeEach(() => {
		state.rows = [];
	});
	test("changing audience preserves creator identity and named grants", () => {
		const change = vi.fn();
		renderToStaticMarkup(
			createElement(ChatSharingOptions<ChatSharingPolicy>, {
				value: policy,
				organizationName: "Team A",
				disabled: false,
				onChange: change,
			}),
		);
		state.rows[0]?.options
			.find((option) => option.key === "organization")
			?.onSelect();
		expect(change).toHaveBeenCalledWith({
			...policy,
			audience: "organization",
		});
		expect(state.rows[0]?.options.map((option) => option.label)).toEqual([
			"Private",
			"Everyone in Team A",
		]);
	});
	test("changing permission preserves the audience and named grants", () => {
		const change = vi.fn();
		renderToStaticMarkup(
			createElement(ChatSharingOptions<ChatSharingPolicy>, {
				value: policy,
				organizationName: "Team A",
				disabled: true,
				onChange: change,
			}),
		);
		expect(state.rows.every((row) => row.disabled && row.compact)).toBe(true);
		state.rows[1]?.options.find((option) => option.key === "edit")?.onSelect();
		expect(change).toHaveBeenCalledWith({ ...policy, permission: "edit" });
	});
	test("non-iOS chat actions include Share only when provided", () => {
		const share = vi.fn();
		const props = {
			isPinned: false,
			onNewChat: vi.fn(),
			onThreads: vi.fn(),
			onChanges: vi.fn(),
			onFiles: vi.fn(),
			onArchive: vi.fn(),
		};
		renderToStaticMarkup(createElement(SessionActionsMenu, props));
		expect(
			state.rows[0]?.options.some((option) => option.key === "share"),
		).toBe(false);
		renderToStaticMarkup(
			createElement(SessionActionsMenu, { ...props, onShare: share }),
		);
		state.rows[1]?.options.find((option) => option.key === "share")?.onSelect();
		expect(share).toHaveBeenCalledOnce();
		expect(
			state.rows[1]?.options.some((option) => option.key === "terminal"),
		).toBe(false);
	});
});
