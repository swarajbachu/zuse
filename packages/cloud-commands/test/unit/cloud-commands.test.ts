import {
	CommandId,
	ComposerInput,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	CLOUD_COMMAND_ELIGIBILITY,
	cloudCommandEligibility,
	cloudCommandEnvelopeEligibility,
	cloudCommandLane,
	cloudMessageSendPayloadLimitation,
	decodeCloudCommandResult,
	decodeCloudMessageSendPayload,
} from "../../src/index.ts";

describe("cloud command policy", () => {
	it("derives routing policy from one executable registry", () => {
		expect(CLOUD_COMMAND_ELIGIBILITY.map((entry) => entry.kind)).toEqual([
			"messages.send",
		]);
		expect(cloudCommandEligibility("messages.send")).toMatchObject({
			kind: "messages.send",
			schemaVersion: 1,
			lane: "session",
		});
		expect(cloudCommandEligibility("git.status")).toBeUndefined();
		expect(
			cloudCommandEnvelopeEligibility({
				kind: "messages.send",
				schemaVersion: 1,
				dependencies: [],
			}),
		).toMatchObject({ kind: "messages.send" });
		expect(
			cloudCommandEnvelopeEligibility({
				kind: "messages.send",
				schemaVersion: 2,
				dependencies: [],
			}),
		).toBeUndefined();
		expect(
			cloudCommandLane({
				kind: "messages.send",
				schemaVersion: 1,
				dependencies: [],
				sessionId: "session-1",
			}),
		).toBe("session:session-1");
	});

	it("uses one payload codec and limitation policy", () => {
		const payload = decodeCloudMessageSendPayload({
			commandId: CommandId.make("message-send:message-1"),
			sessionId: SessionId.make("session-1"),
			clientMessageId: MessageId.make("message-1"),
			text: "hello",
		});
		expect(payload).not.toBeNull();
		if (payload === null) throw new Error("expected payload to decode");
		expect(cloudMessageSendPayloadLimitation(payload)).toBeNull();
		const withModelOptions = decodeCloudMessageSendPayload({
			...payload,
			modelOptions: { reasoning: "high", fastMode: "true" },
		});
		expect(withModelOptions).not.toBeNull();
		if (withModelOptions === null)
			throw new Error("expected model options to decode");
		expect(cloudMessageSendPayloadLimitation(withModelOptions)).toBeNull();
		expect(
			decodeCloudMessageSendPayload({
				...payload,
				modelOptions: { reasoning: 1 },
			}),
		).toBeNull();
		expect(
			decodeCloudMessageSendPayload({
				commandId: "message-send:message-1",
				sessionId: "session-1",
				clientMessageId: "message-1",
			}),
		).toBeNull();
		const richPayload = decodeCloudMessageSendPayload({
			commandId: "message-send:message-1",
			sessionId: "session-1",
			clientMessageId: "message-1",
			input: ComposerInput.make({
				text: "with attachment",
				attachments: [
					{ id: "attachment-1", mimeType: "text/plain", originalName: "a.txt" },
				],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			}),
		});
		if (richPayload === null)
			throw new Error("expected rich payload to decode");
		expect(cloudMessageSendPayloadLimitation(richPayload)).toBe(
			"attachments-not-supported",
		);
		expect(
			decodeCloudMessageSendPayload({
				...richPayload,
				input: { ...richPayload.input, modelOptions: { reasoning: "high" } },
			}),
		).toBeNull();
		const eligibility = cloudCommandEligibility("messages.send");
		if (eligibility === undefined) throw new Error("missing message policy");
		expect(
			decodeCloudCommandResult(eligibility, {
				commandId: "message-send:message-1",
				result: null,
			}),
		).toEqual({ commandId: "message-send:message-1", result: null });
		expect(
			decodeCloudCommandResult(eligibility, {
				commandId: "message-send:message-1",
				result: null,
				unexpected: true,
			}),
		).toBeNull();
	});
});
