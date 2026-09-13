import { describe, expect, it } from "vitest";
import {
	createSidebarGroup,
	dissolveSidebarGroup,
	EMPTY_SIDEBAR_PROJECT_LAYOUT,
	materializeSidebarLayout,
	moveSidebarItem,
	parseSidebarProjectLayout,
	renameSidebarGroup,
	setSidebarGroupCollapsed,
	setSidebarGroupIconColor,
	sidebarEmptyGroupAcceptsDrop,
	sidebarGroupItemKey,
	sidebarProjectRowAcceptsDrop,
} from "../../src/lib/sidebar-project-layout.ts";

const keys = ["alpha", "beta", "gamma"] as const;

describe("materializeSidebarLayout", () => {
	it("appends unseen projects in the given order", () => {
		expect(
			materializeSidebarLayout(keys, EMPTY_SIDEBAR_PROJECT_LAYOUT),
		).toEqual([
			{ kind: "project", key: "alpha" },
			{ kind: "project", key: "beta" },
			{ kind: "project", key: "gamma" },
		]);
	});

	it("drops removed projects and keeps a saved order", () => {
		expect(
			materializeSidebarLayout(["gamma", "alpha"], {
				order: ["beta", "gamma", "alpha"],
				groups: [],
			}),
		).toEqual([
			{ kind: "project", key: "gamma" },
			{ kind: "project", key: "alpha" },
		]);
	});

	it("nests grouped projects under the group node", () => {
		const layout = createSidebarGroup(EMPTY_SIDEBAR_PROJECT_LAYOUT, {
			id: "g1",
			name: "Work",
			projectKeys: ["alpha", "gamma"],
		});
		const nodes = materializeSidebarLayout(keys, {
			...layout,
			order: [sidebarGroupItemKey("g1"), "beta"],
		});
		expect(nodes).toEqual([
			{
				kind: "group",
				group: {
					id: "g1",
					name: "Work",
					collapsed: false,
					projectKeys: ["alpha", "gamma"],
				},
			},
			{ kind: "project", key: "beta" },
		]);
	});
});

describe("moveSidebarItem", () => {
	it("reorders top-level projects", () => {
		const layout = {
			order: ["alpha", "beta", "gamma"],
			groups: [],
		};
		expect(
			materializeSidebarLayout(
				keys,
				moveSidebarItem(
					layout,
					{ kind: "project", key: "gamma" },
					{
						kind: "before",
						itemKey: "alpha",
					},
				),
			).map((node) => (node.kind === "project" ? node.key : node.group.id)),
		).toEqual(["gamma", "alpha", "beta"]);
	});

	it("moves a project into a group", () => {
		const grouped = createSidebarGroup(
			{ order: ["alpha", "beta", "gamma"], groups: [] },
			{ id: "g1", name: "Work", projectKeys: ["alpha"] },
		);
		const moved = moveSidebarItem(
			grouped,
			{ kind: "project", key: "beta" },
			{ kind: "group-end", groupId: "g1" },
		);
		const group = materializeSidebarLayout(keys, moved)[0];
		expect(group).toMatchObject({
			kind: "group",
			group: { projectKeys: ["alpha", "beta"] },
		});
	});

	it("does not nest a group inside another group", () => {
		const two = createSidebarGroup(
			createSidebarGroup(
				{ order: ["alpha", "beta"], groups: [] },
				{ id: "g1", name: "A", projectKeys: ["alpha"] },
			),
			{ id: "g2", name: "B", projectKeys: ["beta"] },
		);
		expect(
			moveSidebarItem(
				two,
				{ kind: "group", id: "g2" },
				{ kind: "group-end", groupId: "g1" },
			),
		).toEqual(two);
	});
});

describe("sidebar drag targets", () => {
	it("does not advertise nested project targets for group drags", () => {
		const group = { kind: "group", id: "g1" } as const;
		expect(sidebarProjectRowAcceptsDrop(group, "g2")).toBe(false);
		expect(sidebarProjectRowAcceptsDrop(group, null)).toBe(true);
	});

	it("accepts only projects in an empty group", () => {
		expect(
			sidebarEmptyGroupAcceptsDrop({ kind: "project", key: "alpha" }),
		).toBe(true);
		expect(sidebarEmptyGroupAcceptsDrop({ kind: "group", id: "g1" })).toBe(
			false,
		);
	});
});

describe("createSidebarGroup / dissolveSidebarGroup", () => {
	it("replaces the first selected project with the group", () => {
		const layout = createSidebarGroup(
			{ order: ["alpha", "beta", "gamma"], groups: [] },
			{ id: "g1", name: "Work", projectKeys: ["beta"] },
		);
		expect(layout.order).toEqual(["alpha", sidebarGroupItemKey("g1"), "gamma"]);
	});

	it("returns grouped projects to the group's former slot", () => {
		const grouped = createSidebarGroup(
			{ order: ["alpha", "beta", "gamma"], groups: [] },
			{ id: "g1", name: "Work", projectKeys: ["beta", "gamma"] },
		);
		expect(dissolveSidebarGroup(grouped, "g1").order).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("renames and collapses without touching membership", () => {
		const grouped = createSidebarGroup(
			{ order: ["alpha"], groups: [] },
			{ id: "g1", name: "Work", projectKeys: ["alpha"] },
		);
		const renamed = renameSidebarGroup(grouped, "g1", "  Client  ");
		expect(renamed.groups[0]?.name).toBe("Client");
		expect(
			setSidebarGroupCollapsed(renamed, "g1", true).groups[0]?.collapsed,
		).toBe(true);
	});
});

describe("parseSidebarProjectLayout", () => {
	it("ignores malformed payloads", () => {
		expect(parseSidebarProjectLayout(null)).toEqual(
			EMPTY_SIDEBAR_PROJECT_LAYOUT,
		);
		expect(
			parseSidebarProjectLayout({ order: [1, "ok"], groups: "nope" }),
		).toEqual({
			order: ["ok"],
			groups: [],
		});
	});

	it("reads a group's icon color", () => {
		expect(
			parseSidebarProjectLayout({
				order: ["group:g1"],
				groups: [
					{
						id: "g1",
						name: "Work",
						collapsed: false,
						projectKeys: ["alpha"],
						iconColor: "rose",
					},
				],
			}).groups[0]?.iconColor,
		).toBe("rose");
	});
});

describe("setSidebarGroupIconColor", () => {
	it("sets and clears color on the group, not on projects", () => {
		const grouped = createSidebarGroup(
			{ order: ["alpha", "beta"], groups: [] },
			{ id: "g1", name: "Work", projectKeys: ["alpha"] },
		);
		const colored = setSidebarGroupIconColor(grouped, "g1", "teal");
		expect(colored.groups[0]?.iconColor).toBe("teal");
		expect(colored.order).toEqual(grouped.order);
		expect(
			setSidebarGroupIconColor(colored, "g1", null).groups[0]?.iconColor,
		).toBeUndefined();
	});
});
