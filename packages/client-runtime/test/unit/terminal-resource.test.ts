import { PtyId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	failTerminalResource,
	initialTerminalResourceState,
	reconnectTerminalResource,
	reduceTerminalOutput,
	resetTerminalProcess,
} from "../../src/terminal-resource.ts";

describe("terminal resource reducer", () => {
	it("advances only contiguous output and ignores duplicates", () => {
		const initial = initialTerminalResourceState(PtyId.make("pty-1"));
		const first = reduceTerminalOutput(initial, { _tag: "data", sequence: 1 });
		expect(first).toMatchObject({
			kind: "accepted",
			state: { outputSequence: 1, phase: "connecting" },
		});
		expect(
			reduceTerminalOutput(first.state, { _tag: "data", sequence: 1 }),
		).toEqual({ kind: "duplicate", state: first.state });
		expect(
			reduceTerminalOutput(first.state, { _tag: "cursor", sequence: 1 }),
		).toMatchObject({ kind: "accepted", state: { phase: "running" } });
	});

	it("requests bounded recovery without advancing across a sequence gap", () => {
		const initial = initialTerminalResourceState(PtyId.make("pty-gap"));
		const first = reduceTerminalOutput(initial, { _tag: "data", sequence: 1 });
		const gap = reduceTerminalOutput(first.state, {
			_tag: "data",
			sequence: 3,
		});
		expect(gap).toMatchObject({
			kind: "recover",
			state: { phase: "reconnecting", outputSequence: 1 },
		});
	});

	it("records an unrecoverable journal gap and process settlement", () => {
		const initial = initialTerminalResourceState(PtyId.make("pty-exit"));
		const gap = reduceTerminalOutput(initial, {
			_tag: "gap",
			requestedAfter: 1,
			earliestAvailable: 7,
			latestAvailable: 9,
		});
		expect(gap).toMatchObject({
			kind: "failed",
			state: {
				phase: "failed",
				outputSequence: 0,
				failure: {
					kind: "replay-gap",
					gap: {
						requestedAfter: 1,
						earliestAvailable: 7,
						latestAvailable: 9,
					},
				},
			},
		});

		const exited = reduceTerminalOutput(initial, {
			_tag: "exit",
			sequence: 1,
			exitCode: 2,
			signal: null,
		});
		expect(exited).toMatchObject({
			kind: "accepted",
			state: {
				phase: "exited",
				outputSequence: 1,
				exitCode: 2,
			},
		});
	});

	it("keeps terminal process epochs stable and terminal failures terminal", () => {
		const initial = initialTerminalResourceState(PtyId.make("pty-stable"));
		expect(initial.processEpoch).toBe("pty:pty-stable");
		const failed = failTerminalResource(initial, {
			kind: "process-missing",
			message: "gone",
		});
		expect(reconnectTerminalResource(failed)).toBe(failed);
		expect(resetTerminalProcess(failed, "runtime-restart-2")).toMatchObject({
			processEpoch: "runtime-restart-2",
			phase: "connecting",
			outputSequence: 0,
		});
	});
});
