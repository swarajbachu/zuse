import { describe, expect, test, vi } from "vitest";

import { createDeduplicatingStderrReporter } from "../../../src/drivers/codex-stderr-reporter.ts";

describe("Codex app-server stderr", () => {
	test("logs one message per noisy category and reports suppression", () => {
		let now = 0;
		const warn = vi.fn();
		const report = createDeduplicatingStderrReporter({
			now: () => now,
			warn,
			windowMs: 1_000,
		});

		report("2026-08-01T00:00:00Z ERROR codex_core_skills::loader: first");
		report("2026-08-01T00:00:01Z ERROR codex_core_skills::loader: second");
		expect(warn).toHaveBeenCalledTimes(1);

		now = 1_001;
		report("2026-08-01T00:00:02Z ERROR codex_core_skills::loader: third");
		expect(warn).toHaveBeenNthCalledWith(
			2,
			"[codex-app-server] suppressed 1 repeated skill-loader messages",
		);
		expect(warn).toHaveBeenCalledTimes(3);
	});

	test("deduplicates structured diagnostics with different timestamps", () => {
		const warn = vi.fn();
		const report = createDeduplicatingStderrReporter({ warn });
		const diagnostic = (timestamp: string) =>
			JSON.stringify({
				timestamp,
				level: "WARN",
				fields: { message: "unknown feature key in config" },
				target: "provider_features",
			});

		report(diagnostic("2026-08-01T00:00:00Z"));
		report(diagnostic("2026-08-01T00:00:01Z"));

		expect(warn).toHaveBeenCalledOnce();
	});

	test("deduplicates ANSI-formatted pretty diagnostics by subsystem", () => {
		const warn = vi.fn();
		const report = createDeduplicatingStderrReporter({ warn });

		report(
			"\u001b[2m2026-08-01T16:33:09.703858Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mrmcp::transport::worker\u001b[0m: worker quit with fatal: first failure",
		);
		report(
			"\u001b[2m2026-08-01T16:33:10.968916Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mrmcp::transport::worker\u001b[0m: worker quit with fatal: another failure",
		);
		report(
			"\u001b[2m2026-08-01T16:33:14.620708Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_models_manager::cache\u001b[0m: stale cache",
		);
		report(
			"\u001b[2m2026-08-01T16:33:21.798475Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_models_manager::cache\u001b[0m: stale cache again",
		);

		expect(warn).toHaveBeenCalledTimes(2);
	});

	test("ignores expected MCP authorization discovery failures", () => {
		const warn = vi.fn();
		const report = createDeduplicatingStderrReporter({ warn });

		report(
			"\u001b[2m2026-08-01T16:49:31.223078Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mrmcp::transport::worker\u001b[0m: worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)",
		);

		expect(warn).not.toHaveBeenCalled();
	});
});
