import type {
	Chat,
	Folder,
	FolderId,
	GitOriginInfo,
	Session,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	buildLogicalProjectGroups,
	computerPickerItems,
	type LogicalProjectGroup,
	preferredGroupMember,
} from "../../src/lib/project-groups.ts";
import type { EnvironmentCatalogEntry } from "../../src/store/environment-catalog.ts";

const folder = (id: string, name: string): Folder =>
	({ id: id as FolderId, name, path: `/repos/${name}` }) as unknown as Folder;

const origin = (owner: string, repo: string): GitOriginInfo =>
	({ host: "github.com", owner, repo }) as unknown as GitOriginInfo;

const chat = (
	id: string,
	projectId: string,
	updatedAt: string,
	archived = false,
): Chat =>
	({
		id,
		projectId,
		title: id,
		archivedAt: archived ? new Date(updatedAt) : null,
		updatedAt: new Date(updatedAt),
	}) as unknown as Chat;

const session = (chatId: string, status: string): Session =>
	({ id: `session-${chatId}`, chatId, status }) as unknown as Session;

const entry = (
	overrides: Partial<EnvironmentCatalogEntry> & {
		environmentId: string;
		label: string;
	},
): EnvironmentCatalogEntry => ({
	connectionKind: "tailnet",
	profileId: overrides.environmentId,
	target: null,
	descriptor: null,
	status: "connected",
	error: null,
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
	...overrides,
});

const build = (input: {
	entries?: ReadonlyArray<EnvironmentCatalogEntry>;
	activeFolders?: ReadonlyArray<Folder>;
	activeOrigins?: Readonly<Record<string, GitOriginInfo | null>>;
	activeChatsByProject?: Readonly<Record<string, ReadonlyArray<Chat>>>;
}): ReadonlyArray<LogicalProjectGroup> =>
	buildLogicalProjectGroups({
		entries: input.entries ?? [],
		activeEnvironmentId: "env-local",
		activeFolders: input.activeFolders ?? [],
		activeOrigins: input.activeOrigins ?? {},
		activeChatsByProject: input.activeChatsByProject ?? {},
	});

const remoteEntry = entry({
	environmentId: "env-remote",
	label: "Studio",
	folders: [folder("rf-1", "zuse-checkout")],
	originsByFolder: { "rf-1": origin("forkzero", "zuse") },
	chatsByProject: {
		"rf-1": [
			chat("remote-old", "rf-1", "2026-08-01T00:00:00Z"),
			chat("remote-new", "rf-1", "2026-08-07T00:00:00Z"),
			chat("remote-archived", "rf-1", "2026-08-08T00:00:00Z", true),
		],
	},
	sessionsByProject: {
		"rf-1": [session("remote-new", "running"), session("remote-old", "exited")],
	},
});

describe("buildLogicalProjectGroups", () => {
	it("merges the same origin across environments into one group", () => {
		const groups = build({
			entries: [
				entry({ environmentId: "env-local", label: "This computer" }),
				remoteEntry,
			],
			activeFolders: [folder("lf-1", "zuse")],
			activeOrigins: { "lf-1": origin("forkzero", "zuse") },
			activeChatsByProject: {
				"lf-1": [chat("local-mid", "lf-1", "2026-08-05T00:00:00Z")],
			},
		});
		expect(groups).toHaveLength(1);
		const group = groups[0];
		expect(group?.key).toBe("github.com/forkzero/zuse");
		expect(group?.members.map((member) => member.environmentId)).toEqual([
			"env-local",
			"env-remote",
		]);
		expect(group?.environmentPresence).toBe("mixed");
	});

	it("never merges originless folders, even with matching names", () => {
		const groups = build({
			entries: [remoteEntry],
			activeFolders: [folder("lf-1", "zuse-checkout")],
			activeOrigins: { "lf-1": null },
		});
		const remoteOnly = entry({
			environmentId: "env-b",
			label: "Laptop",
			folders: [folder("rf-b", "scratch")],
			originsByFolder: { "rf-b": null },
		});
		expect(groups).toHaveLength(2);
		const originless = build({
			entries: [
				entry({
					environmentId: "env-a",
					label: "Desk",
					folders: [folder("rf-a", "scratch")],
					originsByFolder: { "rf-a": null },
				}),
				remoteOnly,
			],
		});
		expect(originless.map((group) => group.key)).toEqual([
			"env-a:rf-a",
			"env-b:rf-b",
		]);
	});

	it("prefers the active member's folder name for display", () => {
		const groups = build({
			entries: [remoteEntry],
			activeFolders: [folder("lf-1", "zuse-local-name")],
			activeOrigins: { "lf-1": origin("forkzero", "zuse") },
		});
		expect(groups[0]?.displayName).toBe("zuse-local-name");
		const withoutActive = build({ entries: [remoteEntry] });
		expect(withoutActive[0]?.displayName).toBe("zuse-checkout");
	});

	it("sorts merged chats by recency, flags remote rows, and drops archived", () => {
		const groups = build({
			entries: [remoteEntry],
			activeFolders: [folder("lf-1", "zuse")],
			activeOrigins: { "lf-1": origin("forkzero", "zuse") },
			activeChatsByProject: {
				"lf-1": [chat("local-mid", "lf-1", "2026-08-05T00:00:00Z")],
			},
		});
		const refs = groups[0]?.chats ?? [];
		expect(refs.map((ref) => ref.chat.id)).toEqual([
			"remote-new",
			"local-mid",
			"remote-old",
		]);
		expect(refs.map((ref) => ref.remote)).toEqual([true, false, true]);
	});

	it("marks a remote chat busy only while a session is booting or running", () => {
		const groups = build({ entries: [remoteEntry] });
		const byId = new Map(
			(groups[0]?.chats ?? []).map((ref) => [String(ref.chat.id), ref.busy]),
		);
		expect(byId.get("remote-new")).toBe(true);
		expect(byId.get("remote-old")).toBe(false);
	});

	it("reports local-only, remote-only, and mixed presence", () => {
		const localOnly = build({
			activeFolders: [folder("lf-1", "solo")],
			activeOrigins: { "lf-1": null },
		});
		expect(localOnly[0]?.environmentPresence).toBe("local-only");
		const remoteOnly = build({ entries: [remoteEntry] });
		expect(remoteOnly[0]?.environmentPresence).toBe("remote-only");
	});

	it("keeps active-workspace ordering first, remaining groups alphabetical", () => {
		const groups = build({
			entries: [
				entry({
					environmentId: "env-remote",
					label: "Studio",
					folders: [folder("rf-z", "zeta"), folder("rf-a", "alpha")],
					originsByFolder: {
						"rf-z": origin("acme", "zeta"),
						"rf-a": origin("acme", "alpha"),
					},
				}),
			],
			activeFolders: [folder("lf-2", "second"), folder("lf-1", "first")],
			activeOrigins: { "lf-1": null, "lf-2": null },
		});
		expect(groups.map((group) => group.displayName)).toEqual([
			"second",
			"first",
			"alpha",
			"zeta",
		]);
	});
});

describe("computerPickerItems", () => {
	const mixedGroup = (): LogicalProjectGroup => {
		const groups = build({
			entries: [
				remoteEntry,
				entry({
					environmentId: "env-offline",
					label: "Old laptop",
					status: "offline",
					folders: [folder("rf-2", "zuse")],
					originsByFolder: { "rf-2": origin("forkzero", "zuse") },
				}),
			],
			activeFolders: [folder("lf-1", "zuse")],
			activeOrigins: { "lf-1": origin("forkzero", "zuse") },
		});
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		return group;
	};

	it("orders the active computer first and disables non-connected members", () => {
		const model = computerPickerItems(mixedGroup(), "env-local");
		expect(model.kind).toBe("menu");
		if (model.kind !== "menu") return;
		expect(model.items.map((item) => item.environmentId)).toEqual([
			"env-local",
			"env-remote",
			"env-offline",
		]);
		expect(model.items.map((item) => item.disabled)).toEqual([
			false,
			false,
			true,
		]);
	});

	it("hides the picker when the only member is on the active environment", () => {
		const groups = build({
			activeFolders: [folder("lf-1", "solo")],
			activeOrigins: { "lf-1": null },
		});
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		expect(computerPickerItems(group, "env-local").kind).toBe("hidden");
	});

	it("renders a static label when the only member is remote", () => {
		const groups = build({ entries: [remoteEntry] });
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		const model = computerPickerItems(group, "env-local");
		expect(model.kind).toBe("static");
		if (model.kind !== "static") return;
		expect(model.item.label).toBe("Studio");
		expect(model.item.disabled).toBe(false);
	});

	it("resolves the preferred member as active first, then first connected", () => {
		const group = mixedGroup();
		expect(preferredGroupMember(group)?.environmentId).toBe("env-local");
		const remoteOnly = build({ entries: [remoteEntry] })[0];
		if (remoteOnly === undefined) throw new Error("expected a group");
		expect(preferredGroupMember(remoteOnly)?.environmentId).toBe("env-remote");
	});
});
