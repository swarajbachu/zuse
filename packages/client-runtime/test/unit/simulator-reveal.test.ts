import { ChatId } from "@zuse/contracts";
import { expect, it } from "vitest";
import { SimulatorSessionReveal } from "../../src/simulators/reveal.ts";

const session = { chatId: ChatId.make("chat"), deviceId: "ABC", openedAt: 1 };
const device = {
	id: "ABC",
	platform: "ios" as const,
	name: "iPhone",
	version: "iOS 26",
	booted: true,
};
it("keeps dismissed viewers closed across snapshots and reveals a new open event", () => {
	const reveal = new SimulatorSessionReveal();
	expect(reveal.update([session], [device])).toEqual([]);
	expect(reveal.update([session], [device])).toEqual([]);
	expect(reveal.update([{ ...session, openedAt: 2 }], [device])).toEqual([
		{ ...session, openedAt: 2 },
	]);
	expect(reveal.update([{ ...session, openedAt: 2 }], [device])).toEqual([]);
	reveal.update([], [device]);
	expect(reveal.update([session], [device])).toEqual([session]);
});
it("waits for a device summary when session state arrives before discovery", () => {
	const reveal = new SimulatorSessionReveal();
	reveal.update([], []);
	expect(reveal.update([session], [])).toEqual([]);
	expect(reveal.update([session], [device])).toEqual([session]);
});

it("does not reopen a dismissed viewer when discovery temporarily disappears", () => {
	const reveal = new SimulatorSessionReveal();
	reveal.update([session], [device]);
	expect(reveal.update([session], [])).toEqual([]);
	expect(reveal.update([session], [device])).toEqual([]);
});
