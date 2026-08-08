import { scopedCacheKey } from "@zuse/client-runtime/environment-scope";
import type { Folder, FolderId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { terminalRuntimeKey } from "../../src/lib/terminal-registry.ts";
import {
	composerDraftKeyForLanding,
	useComposerDraftsStore,
} from "../../src/store/composer-drafts.ts";
import {
	type EnvironmentCatalogEntry,
	orderEnvironmentCatalog,
	validateSshTarget,
} from "../../src/store/environment-catalog.ts";
import {
	activateEnvironmentState,
	createEnvironmentStateRegistry,
} from "../../src/store/environment-state-coordinator.ts";

const entry = (
	label: string,
	profileId: string | null,
	status: EnvironmentCatalogEntry["status"],
	connectionKind: EnvironmentCatalogEntry["connectionKind"] = profileId === null
		? "local"
		: "ssh",
): EnvironmentCatalogEntry => ({
	connectionKind,
	environmentId: `env-${label}`,
	profileId,
	label,
	target: null,
	descriptor: null,
	status,
	error: null,
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
});

describe("environment catalog", () => {
	it("orders local, connected, then offline saved computers", () => {
		expect(
			orderEnvironmentCatalog([
				entry("Offline", "offline", "offline"),
				entry("Local", null, "connected"),
				entry("Relay", null, "connected", "relay"),
				entry("Remote", "remote", "connected"),
			]).map(({ label }) => label),
		).toEqual(["Local", "Relay", "Remote", "Offline"]);
	});

	it("validates manual hosts and ports", () => {
		expect(
			validateSshTarget({
				alias: "",
				hostname: "",
				username: null,
				port: null,
			}),
		).toMatch(/host name/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 70_000,
			}),
		).toMatch(/65535/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 22,
			}),
		).toBeNull();
	});

	it("keeps colliding server IDs distinct across environments", () => {
		expect(scopedCacheKey("env-a", "chat", "same-id")).not.toBe(
			scopedCacheKey("env-b", "chat", "same-id"),
		);
	});

	it("keeps colliding terminal runtime IDs distinct across environments", () => {
		expect(terminalRuntimeKey("env-a", "terminal-1")).not.toBe(
			terminalRuntimeKey("env-b", "terminal-1"),
		);
	});

	it("carries the composer draft into the restored folder's landing key", async () => {
		const folderId = "folder-remote" as FolderId;
		const folder = { id: folderId, name: "Remote folder" } as unknown as Folder;
		const catalogEntry: EnvironmentCatalogEntry = {
			...entry("Remote", "remote", "connected"),
			folders: [folder],
		};
		const selectedFolderId = await activateEnvironmentState({
			fromEnvironmentId: "env-local",
			entry: catalogEntry,
			carryComposerDraft: { doc: "carry me across" },
			activateConnection: async () => undefined,
			resolveEntry: () => catalogEntry,
		});
		expect(selectedFolderId).toBe(folderId);
		expect(
			useComposerDraftsStore.getState().draftsByKey[
				composerDraftKeyForLanding(folderId)
			],
		).toEqual({ doc: "carry me across", chips: [] });
	});

	it("restores isolated state when server IDs collide", () => {
		let state: unknown = { chatId: "same-id", environment: "local" };
		const registry = createEnvironmentStateRegistry([
			{
				getState: () => state,
				getInitialState: () => ({ chatId: null, environment: null }),
				setState: (next) => {
					state = next;
				},
			},
		]);

		registry.capture("env-local");
		state = { chatId: "same-id", environment: "remote" };
		registry.capture("env-remote");

		registry.restore("env-local");
		expect(state).toEqual({ chatId: "same-id", environment: "local" });
		registry.restore("env-remote");
		expect(state).toEqual({ chatId: "same-id", environment: "remote" });
	});
});
