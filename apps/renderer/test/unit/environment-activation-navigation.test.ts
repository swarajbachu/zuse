import { FolderId } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureNewChatLanding,
	openNewChatLanding,
} from "../../src/lib/open-new-chat-landing.ts";
import { switchToEnvironment } from "../../src/lib/switch-environment.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import { useEnvironmentCatalogStore } from "../../src/store/environment-catalog.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const pending = vi.hoisted(() => ({ connect: Promise.resolve() }));
vi.mock(
	"../../src/lib/environment-shell-client-bus.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/environment-shell-client-bus.ts")
		>()),
		retainEnvironmentShell: () => ({
			lease: { activate: () => pending.connect, release: () => {} },
		}),
		subscribeEnvironmentShell: () => () => {},
		environmentShellSnapshot: () => ({
			connection: "connected",
			data: {
				folders: [],
				originsByFolder: {},
				chatsByProject: {},
				sessionsByProject: {},
				creationOperationsByProject: {},
			},
		}),
		dispatchEnvironmentShellCommand: () => new Promise(() => {}),
	}),
);

afterEach(() => vi.unstubAllGlobals());

describe("remote launch activation", () => {
	it("does not commit a remote switch after a newer New Chat request", async () => {
		vi.stubGlobal("location", new URL("http://localhost"));
		const project = FolderId.make("current-project");
		const environmentId = "delayed-remote";
		useEnvironmentCatalogStore.setState({
			entries: [
				{
					environmentId,
					connectionKind: "local",
					profileId: null,
					label: "Remote test",
					target: null,
					descriptor: null,
					status: "connected",
					error: null,
				},
			],
		});
		openNewChatLanding(project);
		const activeEnvironment =
			useEnvironmentCatalogStore.getState().activeEnvironmentId;
		let finish!: () => void;
		pending.connect = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const switching = switchToEnvironment({
			environmentId,
			isCurrent: captureNewChatLanding(),
		});
		openNewChatLanding(project);
		const revision = useChatsStore.getState().landingRevision;
		finish();
		expect(await switching).toEqual({
			switched: false,
			selectedFolderId: null,
		});
		expect(useEnvironmentCatalogStore.getState().activeEnvironmentId).toBe(
			activeEnvironment,
		);
		expect(useWorkspaceStore.getState().selectedFolderId).toBe(project);
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useChatsStore.getState().landingRevision).toBe(revision);
	});
});
