// @vitest-environment jsdom

import { workspaceToolSearch } from "@zuse/extension-sdk";
import { Schema } from "effect";
import { act, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionAttachmentPicker } from "../../src/components/composer/extension-attachment-picker.tsx";

const mocks = vi.hoisted(() => ({
	pending: false,
	invoke: vi.fn(),
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getLocalEnvironmentId: () => "local",
}));
vi.mock("../../src/store/active-workspace.ts", () => ({
	useActiveContext: () => ({
		status: "ready",
		environmentId: "local",
		folderId: "project",
		rootPath: "/repo",
		sessionId: "session",
		worktreeId: null,
		worktreePending: mocks.pending,
	}),
}));
vi.mock("../../src/lib/extension-client-bus.ts", () => ({
	extensionActions: { invoke: mocks.invoke },
}));
const extensions = [
	{
		extensionId: "fixture",
		contributions: {
			attachmentSources: [
				{ id: "context", title: "Fixture", search: workspaceToolSearch },
			],
		},
	},
];
vi.mock("../../src/lib/extension-registry.tsx", () => ({
	useExtensionContributions: () => extensions,
}));
vi.mock("../../src/components/ui/dialog.tsx", () => ({
	Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
		open ? children : null,
	DialogPopup: ({ children }: PropsWithChildren) => <div>{children}</div>,
	DialogPanel: ({ children }: PropsWithChildren) => <div>{children}</div>,
	DialogHeader: ({ children }: PropsWithChildren) => <div>{children}</div>,
	DialogTitle: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
afterEach(() => {
	vi.clearAllMocks();
	mocks.pending = false;
});
it("restarts a pending worktree search and attaches only once while saving", async () => {
	const fixture = Schema.decodeUnknownSync(workspaceToolSearch.output)([
		{ id: "one", title: "Finding", text: "Immutable finding" },
	]);
	mocks.invoke.mockResolvedValue(fixture);
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	let complete: (() => void) | undefined;
	const select = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
	);
	const render = () =>
		act(async () =>
			root.render(<ExtensionAttachmentPicker onSelect={select} />),
		);
	try {
		await render();
		await act(async () => node.querySelector("button")?.click());
		mocks.pending = true;
		await render();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(mocks.invoke).not.toHaveBeenCalled();
		mocks.pending = false;
		await render();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});
		expect(mocks.invoke).toHaveBeenCalledOnce();
		const finding = [...node.querySelectorAll("button")].find(
			(button) => button.textContent === "Finding",
		);
		expect(finding).toBeDefined();
		await act(async () => finding?.click());
		const attach = [...node.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Attach selected"),
		);
		expect(attach).toBeDefined();
		await act(async () => {
			attach?.click();
			attach?.click();
		});
		expect(select).toHaveBeenCalledOnce();
		expect(attach?.disabled).toBe(true);
		await act(async () => complete?.());
		expect(select).toHaveBeenCalledWith(fixture[0]);
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
});
