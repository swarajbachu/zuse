import { AutomationError } from "@zuse/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
	type CloudAutomationEvent,
	deliverCloudAutomationEvents,
} from "../../src/api/cloud-automation-mailbox.ts";

const event = (id: string): CloudAutomationEvent => ({
	id,
	automationId: id,
	eventId: id,
	source: "webhook",
	prompt: "evidence",
	context: {},
});
it("audits permanent rejection, retries transient failures, and continues the batch", async () => {
	const acknowledgments: Array<{ id: string; rejection?: string }> = [];
	const accepted: string[] = [];
	await Effect.runPromise(
		deliverCloudAutomationEvents({
			events: [event("deleted"), event("unavailable"), event("valid")],
			dispatch: (input) => {
				if (input.automationId === "deleted")
					return Effect.fail(
						new AutomationError({ message: "Automation not found." }),
					);
				if (input.automationId === "unavailable")
					return Effect.fail(
						new AutomationError({ message: "Temporary database failure" }),
					);
				return Effect.sync(() => {
					accepted.push(input.context.mailboxEventId ?? "missing");
				});
			},
			ack: (id, rejection) =>
				Effect.sync(() => {
					acknowledgments.push({ id, rejection });
				}),
		}),
	);
	expect(accepted).toEqual(["valid"]);
	expect(acknowledgments).toEqual([
		{ id: "deleted", rejection: "Automation not found." },
		{ id: "valid", rejection: undefined },
	]);
});
it("does not let an acknowledgement failure prevent another event from running", async () => {
	const dispatched: string[] = [];
	await Effect.runPromise(
		deliverCloudAutomationEvents({
			events: [event("first"), event("second")],
			dispatch: (input) =>
				Effect.sync(() => {
					dispatched.push(input.automationId);
				}),
			ack: (id) =>
				id === "first" ? Effect.fail(new Error("offline")) : Effect.void,
		}),
	);
	expect(dispatched).toEqual(["first", "second"]);
});
