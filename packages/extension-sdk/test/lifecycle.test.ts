import { expect, it } from "vitest";
import {
	createExtensionClientRuntime,
	type ExtensionRegistrationCollector,
} from "../src/host.ts";

const collector = (): ExtensionRegistrationCollector => ({
	surfaces: [],
	sidebarItems: [],
	workspacePanels: [],
	commands: [],
	themes: [],
	timelineTransformers: [],
	timelineRenderers: [],
	attachmentSources: [],
});
it("disposes every registration and prevents late initialization from restoring resources", () => {
	const entries = collector();
	const runtime = createExtensionClientRuntime(entries);
	let changes = 0;
	runtime.context.queryState.subscribe(() => changes++);
	runtime.context.queryState.set("key", "before");
	runtime.context.addWorkspacePanel({
		id: "panel",
		title: "Panel",
		icon: "package",
		Component: () => null,
	});
	expect(changes).toBe(1);
	expect(entries.workspacePanels).toHaveLength(1);
	runtime.dispose();
	expect(entries.workspacePanels).toHaveLength(0);
	expect(runtime.context.queryState.get("key")).toBeUndefined();
	expect(() => runtime.context.queryState.set("key", "after")).toThrow(
		"disposed",
	);
	expect(() =>
		runtime.context.addWorkspacePanel({
			id: "late",
			title: "Late",
			icon: "package",
			Component: () => null,
		}),
	).toThrow("disposed");
	expect(changes).toBe(1);
});
it("keeps identical local keys independent between extensions", () => {
	const first = createExtensionClientRuntime(collector());
	const second = createExtensionClientRuntime(collector());
	first.context.queryState.set("selection", "first");
	second.context.queryState.set("selection", "second");
	first.dispose();
	expect(second.context.queryState.get("selection")).toBe("second");
	second.dispose();
});

it("revokes retained desktop action references when an extension is disposed", async () => {
	let opened = 0;
	const host: import("../src/client-host.ts").ExtensionClientHost = {
		openSession: async () => {
			opened++;
		},
		preparePlan: async () => {},
		usePlanOutput: () => ({ text: "", truncated: false, stale: false }),
		useSessions: () => ({
			sessions: [],
			loading: false,
			stale: false,
			error: null,
		}),
		usePullRequest: () => ({
			loading: false,
			stale: false,
			error: null,
			branch: null,
			pullRequest: null,
		}),
	};
	const runtime = createExtensionClientRuntime(collector(), host);
	const open = runtime.context.host.openSession;
	await open("session");
	runtime.dispose();
	await expect(open("session")).rejects.toThrow("disposed");
	expect(() => runtime.context.host.useSessions()).toThrow("disposed");
	expect(opened).toBe(1);
});
