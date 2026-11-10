import { describe, expect, it } from "vitest";

import {
	connectionKind,
	connectionLossCode,
	createConnectionTelemetry,
} from "../../src/lib/connection-telemetry";

describe("connection telemetry", () => {
	it("classifies the connection path", () => {
		expect(
			connectionKind({ host: "127.0.0.1", port: 1, serverKeyPin: "p" }),
		).toBe("local_proxy");
		expect(
			connectionKind({ host: "x", port: 1, refreshAccountGrant: true }),
		).toBe("account");
		expect(connectionKind({ host: "x", port: 1, cloudWorkspaceId: "w" })).toBe(
			"cloud",
		);
	});

	it("reduces raw failures to stable codes", () => {
		expect(connectionLossCode("SocketOpenError: ping timeout")).toBe(
			"ping_timeout",
		);
		expect(connectionLossCode("health check timed out after 8000ms")).toBe(
			"probe_timeout",
		);
		expect(connectionLossCode(undefined)).toBe("other");
	});

	it("reports session lifetime on loss and downtime on recovery", () => {
		let now = 0;
		const record = createConnectionTelemetry(() => now);
		const options = { host: "x", port: 1, refreshAccountGrant: true };

		expect(record("supervisor.connection.ready", "k", {}, options)).toBeNull();
		now = 60_000;
		expect(
			record(
				"supervisor.failure.replace",
				"k",
				{ reason: "ping timeout" },
				options,
			),
		).toEqual({
			name: "connection lost",
			properties: {
				connection_kind: "account",
				duration_ms: 60_000,
				error_code: "ping_timeout",
			},
		});
		now = 61_500;
		expect(record("supervisor.connection.ready", "k", {}, options)).toEqual({
			name: "connection restored",
			properties: { connection_kind: "account", duration_ms: 1_500 },
		});
	});

	it("ignores loss signals while not connected", () => {
		const record = createConnectionTelemetry(() => 0);
		expect(
			record("supervisor.health.failed", "k", {}, { host: "x", port: 1 }),
		).toBeNull();
	});
});
