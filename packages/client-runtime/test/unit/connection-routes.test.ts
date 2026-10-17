import type { ApiConnectGrant } from "@zuse/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
	grantRouteEndpoints,
	raceConnectionRoutes,
} from "../../src/connection-routes";

afterEach(() => vi.useRealTimers());
it("connects through a working fallback without waiting for a hung private route", async () => {
	vi.useFakeTimers();
	const fallback = { dispose: vi.fn(async () => {}) };
	let aborted = false;
	const promise = raceConnectionRoutes(
		["lan", "serve"],
		async (route, signal) => {
			if (route === "serve") return fallback;
			return new Promise<typeof fallback>((_, reject) =>
				signal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				}),
			);
		},
	);
	await vi.advanceTimersByTimeAsync(150);
	expect(await promise).toEqual({ route: "serve", session: fallback });
	expect(aborted).toBe(true);
	expect(fallback.dispose).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
it("disposes a losing session that ignores cancellation and resolves late", async () => {
	vi.useFakeTimers();
	const loser = { dispose: vi.fn(async () => {}) };
	const winner = { dispose: vi.fn(async () => {}) };
	let finish!: (session: typeof loser) => void;
	const promise = raceConnectionRoutes(["slow", "fast"], async (route) =>
		route === "fast"
			? winner
			: new Promise<typeof loser>((resolve) => {
					finish = resolve;
				}),
	);
	await vi.advanceTimersByTimeAsync(150);
	await promise;
	finish(loser);
	await vi.advanceTimersByTimeAsync(0);
	expect(loser.dispose).toHaveBeenCalledTimes(1);
});
it("bounds attempts and leaves no timers after every route fails", async () => {
	vi.useFakeTimers();
	const promise = raceConnectionRoutes(
		["one", "two"],
		async () => new Promise<{ dispose: () => Promise<void> }>(() => {}),
		{ timeoutMs: 100, staggerMs: 10 },
	);
	const assertion = expect(promise).rejects.toThrow("timed out");
	await vi.advanceTimersByTimeAsync(110);
	await assertion;
	expect(vi.getTimerCount()).toBe(0);
});
it("excludes insecure routes in hosted HTTPS clients and deduplicates endpoints", () => {
	const privateRoute = {
		httpBaseUrl: "http://192.168.1.2",
		wsBaseUrl: "ws://192.168.1.2/rpc",
	};
	const managed = {
		httpBaseUrl: "https://host.example",
		wsBaseUrl: "wss://host.example/rpc",
	};
	const grant = {
		connectToken: "token",
		expiresAt: 0,
		endpoint: managed,
		endpointCandidates: [
			{ kind: "private-network", endpoint: privateRoute },
			{ kind: "managed-tunnel", endpoint: managed },
		],
	} as ApiConnectGrant;
	expect(grantRouteEndpoints(grant)).toEqual([privateRoute, managed]);
	expect(grantRouteEndpoints(grant, true)).toEqual([managed]);
});
