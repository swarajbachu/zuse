import { describe, expect, it, vi } from "vitest";
import { makeBufferedInbox } from "../../src/ipc/buffered-inbox.ts";

describe("buffered IPC inbox", () => {
	it("preserves startup frames until the runtime consumer attaches", () => {
		let receive: (frame: string) => void = () => {};
		const unsubscribe = vi.fn();
		const inbox = makeBufferedInbox<string>((next) => {
			receive = next;
			return unsubscribe;
		});
		const delivered: string[] = [];

		receive("handshake");
		receive("settings.stream");
		expect(delivered).toEqual([]);

		inbox.attach((frame) => delivered.push(frame));
		receive("ping");

		expect(delivered).toEqual(["handshake", "settings.stream", "ping"]);
		expect(unsubscribe).not.toHaveBeenCalled();
	});

	it("unsubscribes and discards frames when disposed", () => {
		let receive: (frame: string) => void = () => {};
		const unsubscribe = vi.fn();
		const delivered: string[] = [];
		const inbox = makeBufferedInbox<string>((next) => {
			receive = next;
			return unsubscribe;
		});

		receive("queued");
		inbox.dispose();
		inbox.attach((frame) => delivered.push(frame));
		receive("late");

		expect(delivered).toEqual([]);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
