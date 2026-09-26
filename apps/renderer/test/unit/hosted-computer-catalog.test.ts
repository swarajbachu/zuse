import { type ApiEnvironmentRecord, EnvironmentId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	groupHostedComputers,
	hostedComputerAddress,
} from "../../src/lib/hosted-computer-catalog.ts";

const computer = (
	id: string,
	key?: string,
	lastHeartbeat = 1,
): ApiEnvironmentRecord => ({
	environmentId: EnvironmentId.make(id),
	label: "My laptop",
	providerKind: "desktop",
	linkedAt: 1,
	lastHeartbeat,
	environmentPublicKey: key,
	endpoint: {
		httpBaseUrl: "http://localhost:3000",
		wsBaseUrl: "ws://localhost:3000/rpc",
	},
});
describe("hosted computer catalog", () => {
	it("groups the same key regardless of JSON order, choosing the freshest registration", () => {
		const groups = groupHostedComputers([
			computer("old", '{"kty":"EC","crv":"P-256","x":"x","y":"y"}'),
			computer("new", '{"y":"y","x":"x","crv":"P-256","kty":"EC"}', 2),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.computer.environmentId).toBe("new");
		expect(groups[0]?.registrations).toHaveLength(2);
	});
	it("never merges computers based only on a name or localhost address", () => {
		expect(
			groupHostedComputers([
				computer("one"),
				computer("two"),
				computer("three", "invalid"),
			]),
		).toHaveLength(3);
	});
	it("deduplicates repeated IDs and excludes cloud runtimes", () => {
		expect(
			groupHostedComputers([
				computer("one"),
				computer("one"),
				{ ...computer("cloud"), providerKind: "cloud" },
			]),
		).toHaveLength(1);
	});
	it("distinguishes advertised routes without exposing credentials", () => {
		expect(
			hostedComputerAddress(
				"http://user:secret@localhost:3000/?token=secret#secret",
			),
		).toEqual({ kind: "localhost", address: "http://localhost:3000" });
		expect(hostedComputerAddress("https://laptop.tail.ts.net")).toMatchObject({
			kind: "tailscale",
		});
		expect(hostedComputerAddress("http://192.168.1.2:3000")).toMatchObject({
			kind: "lan",
		});
		expect(hostedComputerAddress("https://computer.zuse.sh")).toMatchObject({
			kind: "remote",
		});
		expect(hostedComputerAddress("javascript:alert(1)")).toBeNull();
	});
});
