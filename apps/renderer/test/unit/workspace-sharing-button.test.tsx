import { ChatId, EnvironmentId, type WorkspaceScope } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	isSignedIn: true,
	chat: null as { readOnly?: boolean } | null,
	scope: { kind: "personal" } as WorkspaceScope,
	cloudOrganization: undefined as string | undefined,
}));
vi.mock("../../src/hooks/use-auth.ts", () => ({ useAuth: () => state }));
vi.mock("../../src/lib/environment-entity-hooks.ts", () => ({
	useEnvironmentChat: () => state.chat,
}));
vi.mock("../../src/lib/renderer-workspace.ts", () => ({
	rendererWorkspaceSnapshot: () => ({ scope: state.scope, epoch: 0 }),
	subscribeRendererWorkspace: () => () => {},
}));
vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	useCloudChatCatalogStore: (
		selector: (value: { summaries: unknown[] }) => unknown,
	) =>
		selector({
			summaries:
				state.cloudOrganization === undefined
					? []
					: [
							{
								workspaceId: "remote",
								chatId: "shared",
								workspaceScope: {
									kind: "organization",
									organizationId: state.cloudOrganization,
								},
							},
						],
		}),
}));

import { WorkspaceSharingButton } from "../../src/components/workspace-sharing-button.tsx";

it.each([
	{ isSignedIn: true, chat: { readOnly: true }, visible: false },
	{ isSignedIn: true, chat: null, visible: false },
	{ isSignedIn: false, chat: {}, visible: false },
	{ isSignedIn: true, chat: {}, visible: true },
])("shows sharing only for a signed-in writable chat: %j", (input) => {
	state.scope = { kind: "personal" };
	state.cloudOrganization = undefined;
	state.isSignedIn = input.isSignedIn;
	state.chat = input.chat;
	const markup = renderToStaticMarkup(
		<WorkspaceSharingButton
			chatRef={{
				environmentId: EnvironmentId.make("remote"),
				chatId: ChatId.make("shared"),
			}}
		/>,
	);
	expect(markup.includes("<button")).toBe(input.visible);
	if (input.visible) {
		expect(markup).toContain("[-webkit-app-region:no-drag]");
		expect(markup).toContain("<svg");
		expect(markup).toContain('data-slot="popover-trigger"');
		expect(markup).toContain("gap-2");
		expect(markup).toContain("size-3");
	}
});

it.each([
	{ selected: "org_a", owner: "org_a", visible: true },
	{ selected: "org_a", owner: "org_b", visible: false },
	{ selected: "org_a", owner: undefined, visible: false },
	{ selected: undefined, owner: "org_a", visible: false },
])("offers access inspection to View members only in the chat's selected organization: %j", ({
	selected,
	owner,
	visible,
}) => {
	state.isSignedIn = true;
	state.chat = { readOnly: true };
	state.scope =
		selected === undefined
			? { kind: "personal" }
			: { kind: "organization", organizationId: selected };
	state.cloudOrganization = owner;
	const markup = renderToStaticMarkup(
		<WorkspaceSharingButton
			chatRef={{
				environmentId: EnvironmentId.make("remote"),
				chatId: ChatId.make("shared"),
			}}
		/>,
	);
	expect(markup.includes("<button")).toBe(visible);
});
