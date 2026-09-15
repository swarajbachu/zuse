import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	setOnline: vi.fn(),
}));

vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	getRendererClientBus: () => ({ setOnline: mocks.setOnline }),
}));

const { installClientBusOnlineBridge } = await import(
	"../../src/lib/client-bus-online.ts"
);

describe("ClientBus platform connectivity bridge", () => {
	it("forwards offline and online edges to the shared runtime owner", () => {
		vi.stubGlobal("window", new EventTarget());
		const cleanup = installClientBusOnlineBridge();

		window.dispatchEvent(new Event("offline"));
		window.dispatchEvent(new Event("online"));

		expect(mocks.setOnline.mock.calls).toEqual([[false], [true]]);
		cleanup();
		window.dispatchEvent(new Event("offline"));
		expect(mocks.setOnline).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});
});
