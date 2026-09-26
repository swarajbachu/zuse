import {
	ComposerInput,
	EnvironmentId,
	FolderId,
	GitPrDetails,
	SessionId,
} from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { PrWatch } from "../../src/store/pr-watch.ts";

const fixture = vi.hoisted(() => ({
	effects: [] as Array<() => void>,
	selectedSessionId: "session",
	activeEnvironmentId: "local",
	watches: [] as PrWatch[],
	prepare: vi.fn(),
	send: vi.fn(),
	workspace: {
		sync: "live",
		connection: "connected",
		data: { status: { branch: "feature" }, error: null },
	},
	details: null as GitPrDetails | null,
	runtime: "idle",
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useEffect: (effect: () => void) => fixture.effects.push(effect),
}));
vi.mock("../../src/lib/git-workspace-client-bus.ts", () => ({
	useGitWorkspaceResource: () => fixture.workspace,
	useGitPrDetailsResource: () => ({
		sync: "live",
		connection: "connected",
		data: { details: fixture.details, error: null },
	}),
}));
vi.mock("../../src/lib/session-timeline-hooks.ts", () => ({
	useRendererSessionTimeline: () => ({
		view: { sync: "live", connection: "connected" },
		projection: { status: "open", queue: { items: [] } },
		runtime: fixture.runtime,
	}),
}));
vi.mock("../../src/lib/pr-repair.ts", () => ({
	preparePrRepair: fixture.prepare,
}));
vi.mock("../../src/lib/session-actions.ts", () => ({
	sendSessionMessage: fixture.send,
}));
vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: vi.fn() },
}));
vi.mock("../../src/store/sessions.ts", () => ({
	useSessionsStore: Object.assign(
		<T,>(select: (s: { selectedSessionId: string }) => T) => select(fixture),
		{ getState: () => fixture },
	),
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: Object.assign(
		<T,>(select: (s: { activeEnvironmentId: string }) => T) => select(fixture),
		{ getState: () => fixture },
	),
}));
vi.mock("../../src/store/pr-watch.ts", () => ({
	usePrWatchStore: Object.assign(
		<T,>(select: (s: { watches: PrWatch[] }) => T) => select(fixture),
		{
			getState: () => ({
				watches: fixture.watches,
				save: (watch: PrWatch) => {
					fixture.watches = [watch];
				},
			}),
		},
	),
}));

import { PrWatchController } from "../../src/components/pr-watch-controller.tsx";

beforeEach(() => {
	fixture.effects = [];
	fixture.selectedSessionId = "session";
	fixture.activeEnvironmentId = "local";
	fixture.runtime = "idle";
	fixture.workspace.data.status.branch = "feature";
	fixture.watches = [
		{
			id: "watch",
			generation: crypto.randomUUID(),
			ref: {
				environmentId: EnvironmentId.make("cloud-workspace"),
				folderId: FolderId.make("folder"),
				worktreeId: null,
				rootPath: "/repo",
			},
			sessionId: SessionId.make("session"),
			url: "https://github.com/o/r/pull/1",
			branch: "feature",
			enabled: true,
			handled: [],
			pending: null,
			maxRepairs: 3,
			error: null,
		},
	];
	fixture.details = GitPrDetails.make({
		state: "open",
		number: 1,
		url: "https://github.com/o/r/pull/1",
		isDraft: false,
		checks: "failure",
		mergeable: "clean",
		additions: 1,
		deletions: 0,
		title: "Feature",
		body: "",
		author: "author",
		baseBranch: "main",
		headBranch: "feature",
		headSha: "head1",
		comments: [],
		reviews: [],
		files: [],
		checkRuns: [
			{
				name: "test",
				status: "completed",
				conclusion: "failure",
				url: "https://github.com/o/r/actions/runs/1/job/2",
				runId: "1",
				jobId: "2",
			},
		],
	});
	fixture.prepare.mockReset().mockResolvedValue(
		new ComposerInput({
			text: "Fix CI",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		}),
	);
	fixture.send.mockReset().mockResolvedValue(true);
});
async function renderWatch() {
	renderToStaticMarkup(createElement(PrWatchController));
	for (const effect of fixture.effects.splice(0)) effect();
	await new Promise((resolve) => setTimeout(resolve, 0));
}
test("auto-fix sends to the selected cloud workspace even when the active catalog environment is local", async () => {
	await renderWatch();
	expect(fixture.send).toHaveBeenCalledOnce();
	expect(fixture.send.mock.calls[0]?.[0]).toEqual({
		environmentId: "cloud-workspace",
		sessionId: "session",
	});
	expect(fixture.watches[0]?.handled).toHaveLength(1);
	await renderWatch();
	expect(fixture.send).toHaveBeenCalledOnce();
});
test("keeps watching the original chat after selecting another chat", async () => {
	fixture.selectedSessionId = "another-session";
	await renderWatch();
	expect(fixture.send).toHaveBeenCalledOnce();
	expect(fixture.send.mock.calls[0]?.[0]).toEqual({
		environmentId: "cloud-workspace",
		sessionId: "session",
	});
});
test("waits for an idle agent", async () => {
	fixture.runtime = "running";
	await renderWatch();
	expect(fixture.send).not.toHaveBeenCalled();
});
test("stops when the branch changes", async () => {
	fixture.workspace.data.status.branch = "another-branch";
	await renderWatch();
	expect(fixture.send).not.toHaveBeenCalled();
	expect(fixture.watches[0]?.enabled).toBe(false);
});

test("retries prepared context after workspace synchronization without preparing twice", async () => {
	fixture.prepare.mockImplementationOnce(async () => {
		fixture.workspace.sync = "synchronizing";
		return new ComposerInput({
			text: "Fix CI",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
	});
	await renderWatch();
	expect(fixture.send).not.toHaveBeenCalled();
	expect(fixture.watches[0]?.pending).not.toBeNull();
	fixture.workspace.sync = "live";
	await renderWatch();
	expect(fixture.send).toHaveBeenCalledOnce();
	expect(fixture.prepare).toHaveBeenCalledOnce();
	expect(fixture.watches[0]?.pending).toBeNull();
});
