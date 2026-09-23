import { beforeEach, describe, expect, it, vi } from "vitest";

const alert = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert } }));

import {
	requestAiSharingConsent,
	resetAiSharingConsent,
} from "../../../src/lib/ai-sharing-consent";

const request = {
	recipient: "Test provider",
	destination: "computer" as const,
	model: "model-a",
};
const choose = (index: number) => alert.mock.lastCall?.[2][index].onPress();
beforeEach(() => {
	resetAiSharingConsent();
	alert.mockClear();
});
describe("AI sharing permission", () => {
	it("does not authorize sharing until explicit agreement", async () => {
		const result = requestAiSharingConsent(request);
		choose(0);
		expect(await result).toBe(false);
		const retry = requestAiSharingConsent(request);
		choose(1);
		expect(await retry).toBe(true);
		expect(await requestAiSharingConsent(request)).toBe(true);
		expect(alert).toHaveBeenCalledTimes(2);
	});
	it("asks again when recipient, model or destination changes", async () => {
		const first = requestAiSharingConsent(request);
		choose(1);
		await first;
		for (const changed of [
			{ ...request, recipient: "Another provider" },
			{ ...request, model: "model-b" },
			{ ...request, destination: "cloud" as const },
		]) {
			const next = requestAiSharingConsent(changed);
			choose(0);
			expect(await next).toBe(false);
		}
		expect(alert).toHaveBeenCalledTimes(4);
	});
	it("coalesces concurrent prompts and invalidates outstanding agreement on reset", async () => {
		const first = requestAiSharingConsent(request);
		const second = requestAiSharingConsent(request);
		expect(first).toBe(second);
		resetAiSharingConsent();
		choose(1);
		expect(await first).toBe(false);
		const next = requestAiSharingConsent(request);
		choose(1);
		expect(await next).toBe(true);
	});
	it("discloses audio transmission and treats dismissal as cancellation", async () => {
		const result = requestAiSharingConsent({
			recipient: "OpenAI",
			destination: "voice",
		});
		expect(alert.mock.lastCall?.[1]).toContain(
			"recording will be sent to OpenAI",
		);
		alert.mock.lastCall?.[3].onDismiss();
		expect(await result).toBe(false);
	});
});
