import { EnvironmentId, type PtyEvent, PtyId } from "@zuse/contracts";
import { Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type {
	ResourceDriverContext,
	ResourceDriverUpdate,
} from "../../src/client-bus.ts";
import type { TerminalResourceState } from "../../src/terminal-resource.ts";
import {
	makeTerminalResourceDriver,
	terminalResourceKey,
} from "../../src/terminal-resource-driver.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

describe("terminal resource driver epochs", () => {
	it("awaits the sink reset before accepting bytes from a new process epoch", async () => {
		const terminalId = PtyId.make("terminal-restart");
		const key = terminalResourceKey({
			environmentId: EnvironmentId.make("environment-restart"),
			terminalId,
		});
		const previous: TerminalResourceState = {
			terminalId,
			processEpoch: "epoch-old",
			phase: "running",
			outputSequence: 7,
			exitCode: null,
			signal: null,
			failure: null,
		};
		const events: ReadonlyArray<typeof PtyEvent.Type> = [
			{ _tag: "epoch", processEpoch: "epoch-new", sequence: 0 },
			{
				_tag: "data",
				processEpoch: "epoch-new",
				sequence: 1,
				bytes: "fresh",
			},
			{ _tag: "cursor", processEpoch: "epoch-new", sequence: 1 },
		];
		const order: string[] = [];
		let finishReset: (() => void) | null = null;
		const updates: ResourceDriverUpdate<TerminalResourceState>[] = [];
		const driver = makeTerminalResourceDriver({
			sinkFor: () => ({
				reset: (processEpoch) =>
					new Promise<void>((resolve) => {
						order.push(`reset:${processEpoch}`);
						finishReset = resolve;
					}),
				write: async (bytes) => {
					order.push(`write:${bytes}`);
				},
				exited: async () => undefined,
			}),
			streamOutput: (_client, _ref, afterSequence, processEpoch) => {
				expect({ afterSequence, processEpoch }).toEqual({
					afterSequence: 7,
					processEpoch: "epoch-old",
				});
				return Stream.concat(Stream.fromIterable(events), Stream.never);
			},
			reportConnectionFailure: () => undefined,
		});
		const context: ResourceDriverContext<unknown, TerminalResourceState> = {
			key,
			client: {},
			generation: 1,
			data: previous,
			cursor: { epoch: "epoch-old", version: 7 },
			snapshot: () => null,
			emit: (update) => {
				updates.push(update);
				return true;
			},
			isCurrent: () => true,
		};

		driver.start(context);
		await waitUntil(() => order.length === 1);
		expect(order).toEqual(["reset:epoch-new"]);
		const resolveReset = finishReset as (() => void) | null;
		resolveReset?.();
		await waitUntil(() => order.length === 2);
		expect(order).toEqual(["reset:epoch-new", "write:fresh"]);
		await waitUntil(() =>
			updates.some(
				(update) =>
					update.data?.processEpoch === "epoch-new" &&
					update.data.outputSequence === 1,
			),
		);
		expect(
			updates.find((update) => update.data?.processEpoch === "epoch-new"),
		).toMatchObject({
			cursor: { epoch: "epoch-new", version: 0 },
			resetEpoch: true,
		});
		driver.stop();
	});

	it("surfaces an ahead-of-server cursor as a recoverable replay gap", async () => {
		const terminalId = PtyId.make("terminal-ahead");
		const environmentId = EnvironmentId.make("environment-ahead");
		const key = terminalResourceKey({ environmentId, terminalId });
		const previous: TerminalResourceState = {
			terminalId,
			processEpoch: "epoch-current",
			phase: "running",
			outputSequence: 99,
			exitCode: null,
			signal: null,
			failure: null,
		};
		const updates: ResourceDriverUpdate<TerminalResourceState>[] = [];
		const reportConnectionFailure = vi.fn();
		const driver = makeTerminalResourceDriver({
			sinkFor: () => ({
				reset: async () => undefined,
				write: async () => undefined,
				exited: async () => undefined,
			}),
			streamOutput: (_client, _ref, afterSequence, processEpoch) => {
				expect({ afterSequence, processEpoch }).toEqual({
					afterSequence: 99,
					processEpoch: "epoch-current",
				});
				return Stream.make({
					_tag: "gap",
					processEpoch: "epoch-current",
					requestedAfter: 99,
					earliestAvailable: 1,
					latestAvailable: 1,
				});
			},
			reportConnectionFailure,
		});
		const context: ResourceDriverContext<unknown, TerminalResourceState> = {
			key,
			client: {},
			generation: 1,
			data: previous,
			cursor: { epoch: "epoch-current", version: 99 },
			snapshot: () => null,
			emit: (update) => {
				updates.push(update);
				return true;
			},
			isCurrent: () => true,
		};

		driver.start(context);
		await waitUntil(() => updates.some((update) => update.sync === "failed"));

		expect(updates.at(-1)).toMatchObject({
			sync: "failed",
			data: {
				phase: "failed",
				outputSequence: 99,
				failure: {
					kind: "replay-gap",
					gap: {
						requestedAfter: 99,
						earliestAvailable: 1,
						latestAvailable: 1,
					},
				},
			},
		});
		expect(reportConnectionFailure).not.toHaveBeenCalled();
		driver.stop();
	});
});
