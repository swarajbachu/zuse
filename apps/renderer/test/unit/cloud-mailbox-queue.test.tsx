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
const command = {
	commandId: CommandId.make("message-send:waiting"),
	kind: "messages.send",
	submittedAt: 1,
	deliveryPhase: "waiting-for-runtime" as const,
};

describe("cloud mailbox queue", () => {
	it("shows the waiting prompt and attachment without losing their content", () => {
		const html = renderToStaticMarkup(
			<CloudMailboxQueue
				messages={[prompt]}
				commands={[{ ...command, cancellable: true }]}
			/>,
		);
		for (const text of [
			"Waiting for agent",
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
			/>,
		);
		expect(html).not.toContain("<button");
	});
	it("leaves no empty tray once the runtime takes the prompt", () => {
		expect(
			renderToStaticMarkup(<CloudMailboxQueue messages={[]} commands={[]} />),
		).toBe("");
	});
});
