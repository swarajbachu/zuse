import { scopedCacheKey } from "@zuse/client-runtime/environment-scope";
import { describe, expect, it } from "vitest";

import {
	type EnvironmentCatalogEntry,
	orderEnvironmentCatalog,
	validateSshTarget,
} from "../../src/store/environment-catalog.ts";
import { createEnvironmentStateRegistry } from "../../src/store/environment-state-coordinator.ts";

const entry = (
	label: string,
	profileId: string | null,
	status: EnvironmentCatalogEntry["status"],
	connectionKind: EnvironmentCatalogEntry["connectionKind"] = profileId === null
		? "local"
		: "ssh",
): EnvironmentCatalogEntry => ({
	connectionKind,
	environmentId: `env-${label}`,
	profileId,
	label,
	target: null,
	descriptor: null,
	status,
	error: null,
	folders: [],
	chatsByProject: {},
	sessionsByProject: {},
});

describe("environment catalog", () => {
	it("orders local, connected, then offline saved computers", () => {
		expect(
			orderEnvironmentCatalog([
				entry("Offline", "offline", "offline"),
				entry("Local", null, "connected"),
				entry("Relay", null, "connected", "relay"),
				entry("Remote", "remote", "connected"),
			]).map(({ label }) => label),
		).toEqual(["Local", "Relay", "Remote", "Offline"]);
	});

	it("validates manual hosts and ports", () => {
		expect(
			validateSshTarget({
				alias: "",
				hostname: "",
				username: null,
				port: null,
			}),
		).toMatch(/host name/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 70_000,
			}),
		).toMatch(/65535/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 22,
			}),
		).toBeNull();
	});

	it("keeps colliding server IDs distinct across environments", () => {
		expect(scopedCacheKey("env-a", "chat", "same-id")).not.toBe(
			scopedCacheKey("env-b", "chat", "same-id"),
		);
	});

	it("restores isolated state when server IDs collide", () => {
		let state: unknown = { chatId: "same-id", environment: "local" };
		const registry = createEnvironmentStateRegistry([
			{
				getState: () => state,
				getInitialState: () => ({ chatId: null, environment: null }),
				setState: (next) => {
					state = next;
				},
			},
		]);

		registry.capture("env-local");
		state = { chatId: "same-id", environment: "remote" };
		registry.capture("env-remote");

		registry.restore("env-local");
		expect(state).toEqual({ chatId: "same-id", environment: "local" });
		registry.restore("env-remote");
		expect(state).toEqual({ chatId: "same-id", environment: "remote" });
	});
});
