// @vitest-environment jsdom
import { ExtensionId, Message, MessageId, SessionId } from "@zuse/contracts";
import type { ExtensionTimelineRendererProps } from "@zuse/extension-sdk";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExtensionTimelineContributions } from "../../src/components/chat-view.tsx";
import { emptyCollector } from "../../src/lib/extension-client-lifecycle.ts";
import type { RegisteredExtension } from "../../src/lib/extension-registry.tsx";

let registrations: readonly RegisteredExtension[] = [];
vi.mock("../../src/lib/extension-registry.tsx", () => ({
	useExtensionContributions: () => registrations,
	extensionHostTheme: { colors: {} },
}));
function Renderer({ item }: ExtensionTimelineRendererProps) {
	if (typeof item.data !== "number")
		throw new Error("Schema output was discarded");
	if (item.data === 1) throw new Error("Old registration failed");
	return <p>Decoded {item.data}</p>;
}
const registration = (value: string): RegisteredExtension => ({
	extensionId: ExtensionId.make("timeline-fixture"),
	error: null,
	contributions: {
		...emptyCollector(),
		timelineRenderers: [
			{
				kind: "fixture",
				version: 1,
				schema: Schema.NumberFromString,
				Component: Renderer,
			},
		],
		timelineTransformers: [
			{
				id: "fixture",
				sourceType: "*",
				transform: () => ({
					items: [
						{ type: "extension", kind: "fixture", version: 1, data: value },
					],
				}),
			},
		],
	},
});
it("passes decoded data and resets failure on reload even when the renderer function is unchanged", async () => {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const node = document.createElement("div");
	const root = createRoot(node);
	const sessionId = SessionId.make("session");
	const message = Message.make({
		id: MessageId.make("message"),
		sessionId,
		role: "user",
		content: { _tag: "user", text: "Hello", goal: false },
		createdAt: new Date(1),
	});
	const render = () =>
		act(async () =>
			root.render(
				<ExtensionTimelineContributions
					message={message}
					sessionId={sessionId}
				/>,
			),
		);
	try {
		registrations = [registration("1")];
		await render();
		expect(node.textContent).not.toContain("Decoded");
		expect(errors).toHaveBeenCalled();
		registrations = [registration("2")];
		await render();
		expect(node.textContent).toBe("Decoded 2");
	} finally {
		await act(async () => root.unmount());
		errors.mockRestore();
		registrations = [];
	}
});
