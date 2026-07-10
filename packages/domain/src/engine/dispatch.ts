import { KeyedSerialWorker } from "@zuse/utils/keyed-worker";
import { Result } from "effect";

import type { SessionCommand } from "../core/commands.js";
import { type DomainError, decide } from "../core/decider.js";
import type { SessionEvent } from "../core/events.js";
import { evolveAll, initialSessionState } from "../core/state.js";

export type StoredEvent = {
	readonly eventId: string;
	readonly correlationId: string;
	readonly causationEventId: string | null;
	readonly streamId: string;
	readonly streamVersion: number;
	readonly sequence: number;
	readonly event: SessionEvent;
};

export type CommandReceipt = {
	readonly commandId: string;
	readonly streamId: string;
	readonly streamVersion: number;
	readonly eventIds: readonly string[];
};

export type DispatchInput = {
	readonly commandId: string;
	readonly streamId: string;
	readonly correlationId?: string;
	readonly causationEventId?: string;
	readonly command: SessionCommand;
};

export type AppendInput = {
	readonly commandId: string;
	readonly streamId: string;
	readonly correlationId: string;
	readonly causationEventId: string | null;
	readonly expectedVersion: number;
	readonly events: readonly {
		readonly eventId: string;
		readonly event: SessionEvent;
	}[];
};

export interface DispatchStorage {
	receipt(commandId: string): Promise<CommandReceipt | null>;
	events(streamId: string): Promise<readonly StoredEvent[]>;
	append(input: AppendInput): Promise<CommandReceipt>;
}

export class ConcurrencyConflict extends Error {
	readonly _tag = "ConcurrencyConflict";
	constructor(
		readonly streamId: string,
		readonly expectedVersion: number,
		readonly actualVersion: number,
	) {
		super(
			`stream ${streamId} expected version ${expectedVersion}, got ${actualVersion}`,
		);
	}
}

export class DispatchEngine {
	private readonly worker = new KeyedSerialWorker<string>();

	constructor(
		private readonly storage: DispatchStorage,
		private readonly makeEventId: () => string,
	) {}

	dispatch(input: DispatchInput): Promise<CommandReceipt> {
		return this.worker.run(input.streamId, () => this.run(input));
	}

	private async run(input: DispatchInput): Promise<CommandReceipt> {
		const existing = await this.storage.receipt(input.commandId);
		if (existing !== null) return existing;

		const stored = await this.storage.events(input.streamId);
		const state = evolveAll(
			initialSessionState,
			stored.map((record) => record.event),
		);
		const decision = decide(state, input.command);
		if (Result.isFailure(decision)) throw decision.failure;

		return this.storage.append({
			commandId: input.commandId,
			streamId: input.streamId,
			correlationId: input.correlationId ?? input.commandId,
			causationEventId: input.causationEventId ?? null,
			expectedVersion: state.version,
			events: decision.success.map((event) => ({
				eventId: this.makeEventId(),
				event,
			})),
		});
	}
}

export class InMemoryDispatchStorage implements DispatchStorage {
	private readonly eventLog: StoredEvent[] = [];
	private readonly receipts = new Map<string, CommandReceipt>();

	receipt(commandId: string): Promise<CommandReceipt | null> {
		return Promise.resolve(this.receipts.get(commandId) ?? null);
	}

	events(streamId: string): Promise<readonly StoredEvent[]> {
		return Promise.resolve(this.eventsFor(streamId));
	}

	eventsFor(streamId: string): readonly StoredEvent[] {
		return this.eventLog.filter((record) => record.streamId === streamId);
	}

	append(input: AppendInput): Promise<CommandReceipt> {
		const existing = this.receipts.get(input.commandId);
		if (existing !== undefined) return Promise.resolve(existing);
		const actualVersion = this.eventsFor(input.streamId).length;
		if (actualVersion !== input.expectedVersion) {
			return Promise.reject(
				new ConcurrencyConflict(
					input.streamId,
					input.expectedVersion,
					actualVersion,
				),
			);
		}
		const eventIds: string[] = [];
		let streamVersion = input.expectedVersion;
		for (const item of input.events) {
			eventIds.push(item.eventId);
			streamVersion += 1;
			this.eventLog.push({
				eventId: item.eventId,
				correlationId: input.correlationId,
				causationEventId: input.causationEventId,
				streamId: input.streamId,
				streamVersion,
				sequence: this.eventLog.length + 1,
				event: item.event,
			});
		}
		const receipt: CommandReceipt = {
			commandId: input.commandId,
			streamId: input.streamId,
			streamVersion,
			eventIds,
		};
		this.receipts.set(input.commandId, receipt);
		return Promise.resolve(receipt);
	}
}

export type DispatchFailure = DomainError | ConcurrencyConflict;
