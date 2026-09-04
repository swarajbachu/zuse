import { CommandId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	cloudComposerSubmissionBlocked,
	commitAcceptedComposerDelivery,
	shouldQueueComposerMessage,
	waitingCloudMessagePresentation,
} from "../../src/lib/composer-delivery.ts";

describe("composer cloud delivery routing", () => {
	it("keeps a second prompt in the composer until the durable send settles", () => {
		for (const deliveryPhase of [
			"accepted",
			"waiting-for-runtime",
			"leased",
			"blocked",
		] as const) {
			expect(
				cloudComposerSubmissionBlocked([
					{
						commandId: CommandId.make(`command-${deliveryPhase}`),
						kind: "messages.send",
						submittedAt: 1,
						deliveryPhase,
					},
				]),
			).toBe(true);
		}
		expect(
			cloudComposerSubmissionBlocked([
				{
					commandId: CommandId.make("queue-add"),
					kind: "messages.queue.add",
					submittedAt: 1,
				},
			]),
		).toBe(false);
	});

	it("sends a new cloud turn through the durable mailbox while compute sleeps", () => {
		expect(
			shouldQueueComposerMessage({
				isCloudSession: true,
				turnInFlight: false,
				hasQueuedMessage: false,
				runtimeStarting: false,
				timelineLive: false,
			}),
		).toBe(false);
	});

	it("preserves queue semantics for an active cloud turn", () => {
		expect(
			shouldQueueComposerMessage({
				isCloudSession: true,
				turnInFlight: true,
				hasQueuedMessage: false,
				runtimeStarting: false,
				timelineLive: true,
			}),
		).toBe(true);
	});

	it("keeps disconnected local and SSH sessions on their existing queue path", () => {
		expect(
			shouldQueueComposerMessage({
				isCloudSession: false,
				turnInFlight: false,
				hasQueuedMessage: false,
				runtimeStarting: false,
				timelineLive: false,
			}),
		).toBe(true);
	});

	it("clears a draft only after delivery acceptance", async () => {
		let clears = 0;
		await expect(
			commitAcceptedComposerDelivery(Promise.resolve(false), () => {
				clears += 1;
			}),
		).resolves.toBe(false);
		expect(clears).toBe(0);

		await expect(
			commitAcceptedComposerDelivery(Promise.resolve(true), () => {
				clears += 1;
			}),
		).resolves.toBe(true);
		expect(clears).toBe(1);
	});

	it("preserves a draft when acceptance rejects", async () => {
		let cleared = false;
		await expect(
			commitAcceptedComposerDelivery(
				Promise.reject(new Error("pre-acceptance failure")),
				() => {
					cleared = true;
				},
			),
		).rejects.toThrow("pre-acceptance failure");
		expect(cleared).toBe(false);
	});

	it.each([
		"accepted",
		"waiting-for-runtime",
		"blocked",
	] as const)("presents a %s cloud message as waiting with its queued cancellation", (deliveryPhase) => {
		const commandId = CommandId.make(`command-${deliveryPhase}`);
		expect(
			waitingCloudMessagePresentation([
				{
					commandId,
					kind: "messages.send",
					submittedAt: 1,
					deliveryPhase,
					cancellable: true,
				},
			]),
		).toEqual({
			commandId,
			label: "Waiting for agent",
			cancellable: true,
		});
	});

	it("removes the waiting presentation once the runtime has leased the message", () => {
		expect(
			waitingCloudMessagePresentation([
				{
					commandId: CommandId.make("command-leased"),
					kind: "messages.send",
					submittedAt: 1,
					deliveryPhase: "leased",
					cancellable: false,
				},
			]),
		).toBeNull();
	});

	it.each([
		["sign-in-required", "auth-restored", "Sign in required"],
		["billing-blocked", "billing-restored", "Billing action required"],
		["update-required", "runtime-compatible", "Update required"],
	] as const)("presents a blocked %s command with its typed action", (category, blockedUntil, label) => {
		const commandId = CommandId.make(`command-${category}`);
		expect(
			waitingCloudMessagePresentation([
				{
					commandId,
					kind: "messages.send",
					submittedAt: 1,
					deliveryPhase: "blocked",
					category,
					blockedUntil,
					cancellable: true,
				},
			]),
		).toEqual({ commandId, label, cancellable: true });
	});
});
