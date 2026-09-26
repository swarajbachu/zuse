import { PtyOwnerId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	makeTerminalCatalogRefreshQueue,
	makeTerminalRouteFence,
	mobileTerminalOwnerId,
	terminalRouteIdentity,
} from "~/lib/terminal-route-fence";

const deferred = <Value>() => {
	let resolve: ((value: Value) => void) | undefined;
	const promise = new Promise<Value>((next) => {
		resolve = next;
	});
	return {
		promise,
		resolve: (value: Value) => resolve?.(value),
	};
};

describe("mobile terminal route fence", () => {
	it("serializes same-route catalog reads so an action receives a fresh snapshot", async () => {
		const queue = makeTerminalCatalogRefreshQueue<string>();
		const first = deferred<string>();
		const starts: string[] = [];
		let serverSnapshot = "stale";
		const stale = queue.run("route-a", () => {
			starts.push("first");
			return first.promise;
		});
		const fresh = queue.run("route-a", () => {
			starts.push("second");
			return serverSnapshot;
		});

		await Promise.resolve();
		expect(starts).toEqual(["first"]);
		serverSnapshot = "fresh-after-action";
		first.resolve("stale-before-action");

		await expect(stale).resolves.toBe("stale-before-action");
		await expect(fresh).resolves.toBe("fresh-after-action");
		expect(starts).toEqual(["first", "second"]);
	});

	it("recovers a same-route catalog lane after a failed read", async () => {
		const queue = makeTerminalCatalogRefreshQueue<string>();
		const failure = new Error("catalog unavailable");
		const failed = queue.run("route-a", () => Promise.reject(failure));
		const recovered = queue.run("route-a", () => "recovered");

		await expect(failed).rejects.toBe(failure);
		await expect(recovered).resolves.toBe("recovered");
	});

	it("does not let a blocked old route delay the new route catalog", async () => {
		const queue = makeTerminalCatalogRefreshQueue<string>();
		const old = deferred<string>();
		const blocked = queue.run("old-route", () => old.promise);

		await expect(queue.run("new-route", () => "new-ready")).resolves.toBe(
			"new-ready",
		);
		old.resolve("old-ready");
		await expect(blocked).resolves.toBe("old-ready");
	});

	it("keeps a queued old-route result fenced after a route commit", async () => {
		const queue = makeTerminalCatalogRefreshQueue<string>();
		const fence = makeTerminalRouteFence();
		const old = deferred<string>();
		const applied: string[] = [];
		fence.commit("old-route");
		const oldRead = queue
			.run("old-route", () => old.promise)
			.then((value) => {
				if (fence.isCurrent("old-route")) applied.push(value);
			});

		fence.commit("new-route");
		await queue
			.run("new-route", () => "new")
			.then((value) => {
				if (fence.isCurrent("new-route")) applied.push(value);
			});
		old.resolve("old");
		await oldRead;

		expect(applied).toEqual(["new"]);
	});

	it("rejects delayed open and catalog results after navigation", async () => {
		const fence = makeTerminalRouteFence();
		const oldRoute = terminalRouteIdentity(
			"old-connection",
			"old-session",
			"/old",
			PtyOwnerId.make("device"),
		);
		fence.commit(oldRoute);
		const oldGeneration = oldRoute;
		const open = deferred<string>();
		const list = deferred<ReadonlyArray<string>>();
		const applied: string[] = [];
		const openResult = open.promise.then((ptyId) => {
			if (fence.isCurrent(oldGeneration)) applied.push(`open:${ptyId}`);
		});
		const listResult = list.promise.then((ptyIds) => {
			if (fence.isCurrent(oldGeneration))
				applied.push(`list:${ptyIds.join(",")}`);
		});

		const newGeneration = terminalRouteIdentity(
			"new-connection",
			"new-session",
			"/new",
			PtyOwnerId.make("device"),
		);
		fence.commit(newGeneration);
		expect(newGeneration).not.toBe(oldGeneration);
		open.resolve("old-pty");
		list.resolve(["old-pty"]);
		await Promise.all([openResult, listResult]);

		expect(applied).toEqual([]);
	});

	it("keeps the committed route authoritative across same-route renders", () => {
		const fence = makeTerminalRouteFence();
		const identity = terminalRouteIdentity(
			"connection",
			"session",
			"/workspace",
			PtyOwnerId.make("device"),
		);
		fence.commit(identity);
		expect(fence.isCurrent(identity)).toBe(true);
		fence.commit(identity);
		expect(fence.isCurrent(identity)).toBe(true);
	});

	it("does not revoke the committed route for an uncommitted render", () => {
		const fence = makeTerminalRouteFence();
		const committed = terminalRouteIdentity(
			"connection-a",
			"session-a",
			"/workspace/a",
			PtyOwnerId.make("device"),
		);
		fence.commit(committed);

		// Computing B models a speculative React render. Authority changes only
		// if the layout phase commits that identity.
		const speculative = terminalRouteIdentity(
			"connection-b",
			"session-b",
			"/workspace/b",
			PtyOwnerId.make("device"),
		);
		expect(fence.isCurrent(committed)).toBe(true);
		expect(fence.isCurrent(speculative)).toBe(false);
	});

	it("isolates terminal catalogs for different sessions on one device", () => {
		const firstOwner = mobileTerminalOwnerId("device", "session-a");
		const secondOwner = mobileTerminalOwnerId("device", "session-b");
		expect(firstOwner).not.toBe(secondOwner);
		expect(
			terminalRouteIdentity("connection", "session-a", "/shared", firstOwner),
		).not.toBe(
			terminalRouteIdentity("connection", "session-b", "/shared", secondOwner),
		);
	});

	it("keeps delimiter-ambiguous device and session tuples isolated", () => {
		expect(mobileTerminalOwnerId("device:one", "session")).not.toBe(
			mobileTerminalOwnerId("device", "one:session"),
		);
	});
});
