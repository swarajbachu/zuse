import type { ExtensionAgentSession } from "@zuse/extension-sdk";
import { expect, it } from "vitest";
import { columns, filterSessions } from "../board.ts";

const sessions: ExtensionAgentSession[] = [
	{
		id: "1",
		projectId: "api",
		projectName: "API",
		title: "Fix login",
		providerId: "codex",
		model: "gpt",
		status: "running",
		updatedAt: "2026-09-14T12:00:00Z",
	},
	{
		id: "2",
		projectId: "web",
		projectName: "Website",
		title: "Review login",
		providerId: "claude",
		model: "sonnet",
		status: "error",
		updatedAt: "2026-09-14T13:00:00Z",
	},
];
it("filters across project and agent without losing the real state", () => {
	expect(
		filterSessions(sessions, "  LOGIN  ", "", "").map((s) => s.id),
	).toEqual(["2", "1"]);
	expect(
		filterSessions(sessions, "login", "api", "codex").map((s) => s.id),
	).toEqual(["1"]);
	expect(filterSessions(sessions, "login", "web", "codex")).toEqual([]);
	expect(filterSessions(sessions, "missing", "", "")).toEqual([]);
	expect(filterSessions([], "", "", "")).toEqual([]);
	expect(columns.map((c) => c.id)).toContain("idle");
	expect(columns.map((c) => c.title)).not.toContain("Done");
});

it("registers one global board destination instead of duplicating it as a workspace panel", async () => {
	const { createExtensionClientRuntime } = await import(
		"@zuse/extension-sdk/host"
	);
	const { default: setup } = await import("../index.client.tsx");
	const contributions = {
		surfaces: [],
		sidebarItems: [],
		workspacePanels: [],
		commands: [],
		themes: [],
		timelineTransformers: [],
		timelineRenderers: [],
		attachmentSources: [],
	};
	const runtime = createExtensionClientRuntime(contributions);
	const cleanup = setup(runtime.context);
	expect(contributions.sidebarItems).toHaveLength(1);
	expect(contributions.workspacePanels).toHaveLength(0);
	expect(contributions.surfaces).toHaveLength(1);
	cleanup();
	runtime.dispose();
});
