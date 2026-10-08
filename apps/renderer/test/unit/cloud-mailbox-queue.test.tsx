import { CommandId, Message, MessageId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudMailboxQueue } from "../../src/components/composer/cloud-mailbox-queue.tsx";

const prompt = Message.make({
	id: MessageId.make("waiting"),
	sessionId: SessionId.make("session"),
	role: "user",
	createdAt: new Date(),
	content: {
		_tag: "user_rich",
		text: "Review these files",
		goal: false,
		attachments: [
			{ id: "upload", originalName: "design.png", mimeType: "image/png" },
		],
		fileRefs: [],
		skillRefs: [],
		annotations: [],
	},
});
const status = { busy: true, label: "Preparing repository…" };
const command = {
	commandId: CommandId.make("message-send:waiting"),
	kind: "messages.send",
	targetId: null,
	submittedAt: 1,
	deliveryPhase: "waiting-for-runtime" as const,
};

describe("cloud mailbox queue", () => {
	it("shows the waiting prompt and attachment without losing their content", () => {
		const html = renderToStaticMarkup(
			<CloudMailboxQueue
				messages={[prompt]}
				commands={[{ ...command, cancellable: true }]}
				status={status}
			/>,
		);
		expect(html.match(/role="status"/g)).toHaveLength(1);
		expect(html).not.toContain("Waiting for agent");
		for (const text of [
			"Preparing repository…",
			"Review these files",
			"design.png",
			"Cancel",
		])
			expect(html).toContain(text);
	});
	it("only offers cancellation when the mailbox permits it", () => {
		const html = renderToStaticMarkup(
			<CloudMailboxQueue
				messages={[prompt]}
				commands={[{ ...command, cancellable: false }]}
				status={status}
			/>,
		);
		expect(html).not.toContain("<button");
	});
	it("leaves no empty tray once the runtime takes the prompt", () => {
		expect(
			renderToStaticMarkup(
				<CloudMailboxQueue messages={[]} commands={[]} status={status} />,
			),
		).toBe("");
	});
});
