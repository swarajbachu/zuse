import type {
	Chat,
	Folder,
	FolderId,
	GitOriginInfo,
	Session,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import type { EnvironmentShellData } from "../../src/lib/environment-shell-client-bus.ts";
import {
	buildLogicalProjectGroups,
	computerPickerItems,
	type LogicalProjectGroup,
	preferredGroupMember,
} from "../../src/lib/project-groups.ts";
import type { EnvironmentCatalogEntry } from "../../src/store/environment-catalog.ts";

type CatalogFixtureEntry = EnvironmentCatalogEntry &
	Partial<EnvironmentShellData>;

const folder = (id: string, name: string): Folder =>
	({ id: id as FolderId, name, path: `/repos/${name}` }) as unknown as Folder;

const origin = (owner: string, repo: string): GitOriginInfo =>
	({
		host: "github.com",
		owner,
		repo,
		cloneUrl: `git@github.com:${owner}/${repo}.git`,
	}) as unknown as GitOriginInfo;

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
	overrides: Partial<CatalogFixtureEntry> & {
		environmentId: string;
		label: string;
	},
): CatalogFixtureEntry => ({
	connectionKind: "tailnet",
	profileId: overrides.environmentId,
	target: null,
	descriptor: null,
	status: "connected",
	error: null,
	...overrides,
});

const build = (input: {
	entries?: ReadonlyArray<CatalogFixtureEntry>;
	activeEnvironmentId?: string;
	localEnvironmentId?: string;
	activeFolders?: ReadonlyArray<Folder>;
	activeOrigins?: Readonly<Record<string, GitOriginInfo | null>>;
	activeChatsByProject?: Readonly<Record<string, ReadonlyArray<Chat>>>;
	shellsByEnvironment?: Parameters<
		typeof buildLogicalProjectGroups
	>[0]["shellsByEnvironment"];
}): ReadonlyArray<LogicalProjectGroup> => {
	const entries = input.entries ?? [];
	return buildLogicalProjectGroups({
		entries,
		activeEnvironmentId: input.activeEnvironmentId ?? "env-local",
		localEnvironmentId: input.localEnvironmentId ?? "env-local",
		activeFolders: input.activeFolders ?? [],
		activeOrigins: input.activeOrigins ?? {},
		activeChatsByProject: input.activeChatsByProject ?? {},
		shellsByEnvironment:
			input.shellsByEnvironment ??
			Object.fromEntries(
				entries.map((entry) => [
					entry.environmentId,
					{
						folders: entry.folders ?? [],
						originsByFolder: entry.originsByFolder ?? {},
						chatsByProject: entry.chatsByProject ?? {},
						sessionsByProject: entry.sessionsByProject ?? {},
						creationOperationsByProject: {},
					},
				]),
			),
	});
};

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

	it("anchors remote badges to the physical desktop, not the active environment", () => {
		const localEntry = entry({
			environmentId: "env-local",
			label: "MacBook",
			connectionKind: "local",
			folders: [folder("lf-1", "zuse")],
			originsByFolder: { "lf-1": origin("forkzero", "zuse") },
			chatsByProject: {
				"lf-1": [chat("local-mid", "lf-1", "2026-08-05T00:00:00Z")],
			},
		});
		// The REMOTE environment is active — the app is looking at Studio's chat.
		const groups = build({
			entries: [localEntry, remoteEntry],
			activeEnvironmentId: "env-remote",
			localEnvironmentId: "env-local",
			activeFolders: [folder("rf-1", "zuse-checkout")],
			activeOrigins: { "rf-1": origin("forkzero", "zuse") },
			activeChatsByProject: {
				"rf-1": [chat("remote-new", "rf-1", "2026-08-07T00:00:00Z")],
			},
		});
		const refs = groups[0]?.chats ?? [];
		const byId = new Map(refs.map((ref) => [String(ref.chat.id), ref]));
		// The active environment's live rows still read as remote…
		expect(byId.get("remote-new")?.remote).toBe(true);
		expect(byId.get("remote-new")?.live).toBe(true);
		// …and this desktop's rows (fed from the catalog) never do.
		expect(byId.get("local-mid")?.remote).toBe(false);
		expect(byId.get("local-mid")?.live).toBe(false);
		// Presence is desktop-anchored too — identical to when local is active.
		expect(groups[0]?.environmentPresence).toBe("mixed");
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

	it("orders this desktop first and disables non-connected members", () => {
		const model = computerPickerItems(mixedGroup(), null);
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
			false,
		]);
		expect(model.items[2]?.retryable).toBe(true);
	});

	it("defaults selection to this desktop's member and honors an explicit target", () => {
		const group = mixedGroup();
		const defaulted = computerPickerItems(group, null);
		if (defaulted.kind !== "menu") throw new Error("expected a menu");
		expect(defaulted.items.find((item) => item.selected)?.environmentId).toBe(
			"env-local",
		);
		const targeted = computerPickerItems(group, {
			environmentId: "env-remote",
			folderId: "rf-1" as FolderId,
		});
		if (targeted.kind !== "menu") throw new Error("expected a menu");
		expect(targeted.items.find((item) => item.selected)?.environmentId).toBe(
			"env-remote",
		);
	});

	it("hides the picker when the only member is on this desktop", () => {
		const offlineComputer = entry({
			environmentId: "env-offline",
			label: "Old laptop",
			status: "error",
			error: "Couldn't reach the computer.",
		});
		const groups = build({
			activeFolders: [folder("lf-1", "solo")],
			activeOrigins: { "lf-1": null },
		});
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		expect(computerPickerItems(group, null).kind).toBe("hidden");
		const withSavedComputer = computerPickerItems(group, null, [
			offlineComputer,
		]);
		expect(withSavedComputer.kind).toBe("menu");
		if (withSavedComputer.kind !== "menu") return;
		expect(withSavedComputer.items).toEqual([
			expect.objectContaining({
				environmentId: "env-local",
				folderId: "lf-1",
				projectAvailable: true,
				selected: true,
			}),
			expect.objectContaining({
				environmentId: "env-offline",
				folderId: null,
				label: "Old laptop",
				projectAvailable: false,
				retryable: true,
				disabled: false,
			}),
		]);
	});

	it("keeps an originless project unavailable on a connected computer", () => {
		const groups = build({
			activeFolders: [folder("lf-1", "solo")],
			activeOrigins: { "lf-1": null },
		});
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		const model = computerPickerItems(group, null, [
			entry({ environmentId: "env-other", label: "Studio" }),
		]);
		expect(model.kind).toBe("menu");
		if (model.kind !== "menu") return;
		expect(model.items[1]).toEqual(
			expect.objectContaining({
				environmentId: "env-other",
				folderId: null,
				projectAvailable: false,
				retryable: false,
				disabled: true,
			}),
		);
	});

	it("allows a connected computer to be selected for Git-backed setup", () => {
		const groups = build({
			activeFolders: [folder("lf-1", "solo")],
			activeOrigins: { "lf-1": origin("team", "solo") },
		});
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		const model = computerPickerItems(
			group,
			{ environmentId: "env-other", folderId: null },
			[entry({ environmentId: "env-other", label: "Studio" })],
		);
		expect(model.kind).toBe("menu");
		if (model.kind !== "menu") return;
		expect(model.items[1]).toEqual(
			expect.objectContaining({
				environmentId: "env-other",
				folderId: null,
				projectAvailable: false,
				setupAvailable: true,
				selected: true,
				disabled: false,
			}),
		);
	});

	it("renders a static label when the only member is remote", () => {
		const groups = build({ entries: [remoteEntry] });
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		const model = computerPickerItems(group, null);
		expect(model.kind).toBe("static");
		if (model.kind !== "static") return;
		expect(model.item.label).toBe("Studio");
		expect(model.item.disabled).toBe(false);
	});

	it("shows a static label for a single active member that is not this desktop", () => {
		// The remote env is active and owns the only checkout of this repo.
		const groups = build({
			activeEnvironmentId: "env-remote",
			localEnvironmentId: "env-local",
			activeFolders: [folder("rf-1", "zuse-checkout")],
			activeOrigins: { "rf-1": origin("forkzero", "zuse") },
		});
		const group = groups[0];
		if (group === undefined) throw new Error("expected a group");
		expect(computerPickerItems(group, null).kind).toBe("static");
	});

	it("resolves the preferred member as active first, then first connected", () => {
		const group = mixedGroup();
		expect(preferredGroupMember(group)?.environmentId).toBe("env-local");
		const remoteOnly = build({ entries: [remoteEntry] })[0];
		if (remoteOnly === undefined) throw new Error("expected a group");
		expect(preferredGroupMember(remoteOnly)?.environmentId).toBe("env-remote");
	});
});
