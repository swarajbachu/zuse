import { EnvironmentId, FolderId, Session, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../../src/components/chat-composer.tsx";
import { useSessionsStore } from "../../src/store/sessions.ts";

// Provider/model inventory is independent of applied access and requires a live client.
vi.mock("../../src/components/model-picker.tsx", () => ({
	ModelPicker: ({ runtimeMode }: { runtimeMode: string }) => (
		<span data-runtime-mode={runtimeMode} />
	),
}));

vi.mock("../../src/lib/session-timeline-hooks.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-hooks.ts")
	>()),
	useRendererSessionTimeline: () => ({
		projection: { runtimeMode: "approval-required", queue: { items: [] } },
		view: { data: null, pendingCommands: [], failedCommands: [], sync: "live" },
		messages: [],
		runtime: "idle",
	}),
}));

describe("composer applied access", () => {
	it("renders the runtime's applied access instead of a stale Full Access catalog row", () => {
		const draft = useSessionsStore.getState().beginDraft({
			projectId: FolderId.make("project-1"),
			providerId: "codex",
			model: "gpt-5.6-sol",
			runtimeMode: "full-access",
		});
		const session = Session.make({
			...draft,
			id: SessionId.make("cloud-session"),
		});
		const html = renderToStaticMarkup(
			<ChatComposer
				session={session}
				environmentId={EnvironmentId.make("cloud-1")}
			/>,
		);
		expect(html).toContain("Supervised");
		expect(html).not.toContain("Full access");
		expect(html).toContain('data-runtime-mode="approval-required"');
	});
});
