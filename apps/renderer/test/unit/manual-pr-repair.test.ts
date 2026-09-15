import { ComposerInput, EnvironmentId, SessionId } from "@zuse/contracts";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), pending: vi.fn() }));
vi.mock("../../src/lib/session-actions.ts", () => ({
	sendSessionMessage: mocks.send,
}));
vi.mock("../../src/lib/pending-session-messages.ts", () => ({
	pendingSessionMessages: mocks.pending,
}));

import { sendManualPrRepair } from "../../src/lib/manual-pr-repair.ts";

const ref = {
	environmentId: EnvironmentId.make("local"),
	sessionId: SessionId.make("test"),
};
const input = ComposerInput.make({
	text: "Repair",
	attachments: [],
	fileRefs: [],
	skillRefs: [],
});
test("an ambiguous retry preserves both the original ID and payload", async () => {
	mocks.send
		.mockImplementationOnce(async (_ref, _input, { messageId }) => {
			mocks.pending.mockReturnValue([{ id: messageId }]);
			return false;
		})
		.mockResolvedValueOnce(true);
	expect(await sendManualPrRepair(ref, "ambiguous", input)).toBe(false);
	expect(
		await sendManualPrRepair(
			ref,
			"ambiguous",
			ComposerInput.make({ ...input, text: "Regenerated" }),
		),
	).toBe(true);
	expect(mocks.send.mock.calls[1]).toEqual(mocks.send.mock.calls[0]);
});
test("terminal rejection allows a new attempt instead of retaining the rejected command", async () => {
	mocks.send
		.mockReset()
		.mockResolvedValueOnce(false)
		.mockResolvedValueOnce(true);
	mocks.pending.mockReturnValue([]);
	await sendManualPrRepair(ref, "terminal", input);
	await sendManualPrRepair(ref, "terminal", input);
	expect(mocks.send.mock.calls[0]?.[2].messageId).not.toBe(
		mocks.send.mock.calls[1]?.[2].messageId,
	);
});
