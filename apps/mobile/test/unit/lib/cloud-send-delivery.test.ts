import { isWaitingCloudSend } from "@zuse/client-runtime/cloud-send-delivery";
import { expect, test } from "vitest";

const send = (deliveryPhase?: string) =>
	({ kind: "messages.send", deliveryPhase }) as never;

test("a mailbox send nobody has claimed is waiting, not running", () => {
	for (const phase of [
		undefined,
		"persisting",
		"reserved",
		"accepted",
		"waiting-for-runtime",
		"blocked",
	])
		expect(isWaitingCloudSend(send(phase))).toBe(true);
	expect(isWaitingCloudSend(send("leased"))).toBe(false);
	expect(isWaitingCloudSend({ kind: "messages.interrupt" } as never)).toBe(
		false,
	);
});
