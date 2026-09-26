import { PtyOwnerId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	makeDeveloperToolsRefreshAuthority,
	runBoundedDeveloperToolTasks,
	uniqueDeveloperTerminalTargets,
} from "~/lib/developer-tools-refresh";

describe("developer tools refresh", () => {
	it("deduplicates owner catalogs per connection without delimiter collisions", () => {
		const first = {
			connectionKey: "connection:one",
			ownerId: PtyOwnerId.make("owner"),
			label: "first",
		};
		const duplicate = { ...first, label: "duplicate" };
		const structurallyDifferent = {
			connectionKey: "connection",
			ownerId: PtyOwnerId.make("one:owner"),
			label: "different",
		};

		expect(
			uniqueDeveloperTerminalTargets([first, duplicate, structurallyDifferent]),
		).toEqual([first, structurallyDifferent]);
	});

	it("bounds aggregate RPC concurrency while preserving task order", async () => {
		let active = 0;
		let peak = 0;
		const tasks = Array.from({ length: 12 }, (_, index) => async () => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 2));
			active -= 1;
			return index;
		});

		await expect(runBoundedDeveloperToolTasks(tasks, 3)).resolves.toEqual(
			Array.from({ length: 12 }, (_, index) => index),
		);
		expect(peak).toBe(3);
	});

	it("stops scheduling after a task fails and waits for started work to settle", async () => {
		const failure = new Error("unexpected task defect");
		const started: number[] = [];
		let finishStartedTask!: () => void;
		const startedTask = new Promise<void>((resolve) => {
			finishStartedTask = resolve;
		});
		const tasks = [
			async () => {
				started.push(0);
				throw failure;
			},
			async () => {
				started.push(1);
				await startedTask;
				return 1;
			},
			async () => {
				started.push(2);
				return 2;
			},
		];
		let outcome: unknown = null;
		const run = runBoundedDeveloperToolTasks(tasks, 2).then(
			() => {
				outcome = "resolved";
			},
			(cause: unknown) => {
				outcome = cause;
			},
		);

		await Promise.resolve();
		await Promise.resolve();
		const outcomeBeforeStartedWorkSettled = outcome;
		finishStartedTask();
		await run;

		expect(outcomeBeforeStartedWorkSettled).toBeNull();
		expect(outcome).toBe(failure);
		expect(started).toEqual([0, 1]);
	});

	it("lets only the latest overlapping refresh commit", () => {
		const authority = makeDeveloperToolsRefreshAuthority();
		const first = authority.begin();
		const second = authority.begin();

		expect(authority.isCurrent(first)).toBe(false);
		expect(authority.isCurrent(second)).toBe(true);
		authority.invalidate();
		expect(authority.isCurrent(second)).toBe(false);
	});
});
