import {
	ChatCreateRpc,
	CommandId,
	ComposerInput,
	MachineSshKeysAddRpc,
	MachineSshKeysAddRpcPayload,
	MessagesQueueAddRpc,
	MessagesQueueUpdateRpc,
	MessagesSendRpc,
	PtyOpenRpc,
	PtyOpenToken,
	PtyOwnerId,
	PtyOwnership,
	SessionId,
} from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { rehydrateClientCommandPayload } from "../../src/client-command-payload.ts";

const composerInput = () =>
	ComposerInput.make({
		text: "durable prompt",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
		annotations: [],
	});

const jsonRoundTrip = <Value>(value: Value): Value =>
	JSON.parse(JSON.stringify(value)) as Value;

describe("durable ClientBus command payload rehydration", () => {
	it.each([
		[
			"messages.send",
			MessagesSendRpc.payloadSchema,
			{
				commandId: CommandId.make("send-command"),
				sessionId: SessionId.make("send-session"),
				input: composerInput(),
			},
		],
		[
			"messages.queue.add",
			MessagesQueueAddRpc.payloadSchema,
			{
				commandId: CommandId.make("add-command"),
				sessionId: SessionId.make("add-session"),
				queueId: "queued-message",
				input: composerInput(),
			},
		],
		[
			"messages.queue.update",
			MessagesQueueUpdateRpc.payloadSchema,
			{
				commandId: CommandId.make("update-command"),
				sessionId: SessionId.make("update-session"),
				queueId: "queued-message",
				input: composerInput(),
			},
		],
	] as const)("rehydrates %s after a mobile JSON round trip", (kind, schema, fresh) => {
		const persisted = jsonRoundTrip(fresh);
		const replayed = rehydrateClientCommandPayload(kind, persisted);

		expect(persisted.input).not.toBeInstanceOf(ComposerInput);
		expect(replayed.input).toBeInstanceOf(ComposerInput);
		expect(() => Schema.encodeSync(schema)(replayed)).not.toThrow();
	});

	it("rehydrates nested desktop classes after a structured clone", () => {
		const input = composerInput();
		const ownership = PtyOwnership.make({
			ownerId: PtyOwnerId.make("desktop-owner"),
			label: "Project shell",
			scope: "session",
			openToken: PtyOpenToken.make("logical-terminal-slot"),
		});
		const chatPayload = structuredClone({
			projectId: "project-1",
			providerId: "claude",
			model: "model-1",
			startupInput: input,
		});
		const ptyPayload = structuredClone({
			cwd: "/workspace",
			cols: 80,
			rows: 24,
			ownership,
		});

		const chat = rehydrateClientCommandPayload("chat.create", chatPayload);
		const pty = rehydrateClientCommandPayload("pty.open", ptyPayload);

		expect(chat.startupInput).toBeInstanceOf(ComposerInput);
		expect(pty.ownership).toBeInstanceOf(PtyOwnership);
		expect(() =>
			Schema.encodeUnknownSync(ChatCreateRpc.payloadSchema)(chat),
		).not.toThrow();
		expect(() =>
			Schema.encodeSync(PtyOpenRpc.payloadSchema)(pty),
		).not.toThrow();
	});

	it("rehydrates a top-level Schema.Class payload", () => {
		const persisted = structuredClone(
			MachineSshKeysAddRpcPayload.make({
				publicKey: "ssh-ed25519 AAAA durable@example",
				label: "zuse-desktop",
			}),
		);
		const replayed = rehydrateClientCommandPayload(
			"machine.sshKeys.add",
			persisted,
		);

		expect(persisted).not.toBeInstanceOf(MachineSshKeysAddRpcPayload);
		expect(replayed).toBeInstanceOf(MachineSshKeysAddRpcPayload);
		expect(() =>
			Schema.encodeSync(MachineSshKeysAddRpc.payloadSchema)(replayed),
		).not.toThrow();
	});

	it("fails closed for malformed and unregistered command payloads", () => {
		expect(() =>
			rehydrateClientCommandPayload("pty.open", {
				cwd: "/workspace",
				cols: 80,
				rows: 24,
				ownership: { ownerId: 42, openToken: "logical-terminal-slot" },
			}),
		).toThrow();
		expect(() => rehydrateClientCommandPayload("client.unknown", {})).toThrow(
			"No RPC payload schema is registered for ClientBus command",
		);
	});
});
