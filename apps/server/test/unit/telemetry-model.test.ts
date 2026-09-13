import { Exit } from "effect";
import { describe, expect, it } from "vitest";

import { telemetryEventFromSpan } from "../../src/observability/telemetry-model.ts";

describe("telemetry model", () => {
	it("creates a correlated successful operation without persisting sensitive attributes", () => {
		const result = telemetryEventFromSpan({
			name: "RpcServer.session.get",
			traceId: "trace-1",
			spanId: "span-1",
			startTime: 1_000_000_000n,
			endTime: 1_025_000_000n,
			exit: Exit.succeed("ok"),
			attributes: new Map([
				["session.id", "session-1"],
				["provider.id", "codex"],
				["prompt", "do not persist me"],
			]),
			runId: "run-1",
		});

		expect(result).toMatchObject({
			id: "span_trace-1_span-1",
			severity: "info",
			source: "server.persistence",
			category: "persistence",
			message: "RpcServer.session.get",
			traceId: "trace-1",
			spanId: "span-1",
			sessionId: "session-1",
			providerId: "codex",
			durationMs: 25,
			recoveryStatus: "not-needed",
		});
		expect(result.detail).not.toContain("do not persist me");
	});

	it("classifies RPC boundaries by subsystem", () => {
		const names = [
			["RpcServer.permission.respond", "permission"],
			["RpcServer.git.status", "git"],
			["RpcServer.pty.open", "terminal"],
			["RpcServer.api.connect", "network"],
			["RpcServer.auth.signIn", "auth"],
			["RpcServer.attachment.add", "attachment"],
			["RpcServer.mcp.list", "mcp"],
		] as const;

		for (const [name, category] of names) {
			const result = telemetryEventFromSpan({
				name,
				traceId: `trace-${category}`,
				spanId: `span-${category}`,
				startTime: 1_000_000_000n,
				endTime: 1_001_000_000n,
				exit: Exit.succeed("ok"),
				attributes: new Map(),
				runId: "run-1",
			});
			expect(result.category).toBe(category);
		}
	});

	it("captures a sanitized failure and classifies provider operations", () => {
		const result = telemetryEventFromSpan({
			name: "provider.send",
			traceId: "trace-2",
			spanId: "span-2",
			startTime: 2_000_000_000n,
			endTime: 2_500_000_000n,
			exit: Exit.fail(new Error("Authorization: Bearer secret-value")),
			attributes: new Map(),
			runId: "run-1",
		});

		expect(result).toMatchObject({
			severity: "error",
			source: "server.provider",
			category: "provider",
			recoveryStatus: "unresolved",
		});
		expect(result.detail).toContain('"type": "Error"');
		expect(result.detail).not.toContain("Authorization");
		expect(result.detail).not.toContain("secret-value");
	});
});
