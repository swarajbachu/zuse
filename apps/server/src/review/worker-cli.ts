import { parseArgs } from "node:util";
import { ReviewSnapshot } from "@zuse/contracts";
import { Schema } from "effect";
import { runNativeLogin } from "./native-login.ts";
import { serveReviewReader } from "./reader-service.ts";
import { runNativeWorkerRuntime } from "./worker-runtime.ts";

const { values, positionals } = parseArgs({
	options: {
		check: { type: "boolean" },
		root: { type: "string" },
		snapshot: { type: "string" },
		"attempt-id": { type: "string" },
		"api-origin": { type: "string" },
		"status-file": { type: "string" },
		"callback-file": { type: "string" },
	},
	allowPositionals: true,
});
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const executablePath = "/opt/zuse/claude";
try {
	if (values.check) {
		process.stdout.write(
			`${JSON.stringify({
				protocol: 1,
				provider: "claude",
				sdkVersion: "0.3.276",
			})}\n`,
		);
	} else if (positionals[0] === "reader") {
		if (process.getuid?.() !== 1001 || !values.root || !values.snapshot)
			throw new Error("Reader identity required");
		await serveReviewReader(
			values.root,
			Schema.decodeUnknownSync(ReviewSnapshot)(JSON.parse(values.snapshot)),
		);
	} else if (positionals[0] === "login") {
		if (
			values["status-file"] !== "/run/zuse-review-login/status.json" ||
			values["callback-file"] !== "/run/zuse-review-login/callback.json"
		)
			throw new Error("Invalid login paths");
		await runNativeLogin({
			executablePath,
			authHome: "/run/zuse-review-auth",
			trustedCwd: "/run/zuse-review-login/native",
			statusFile: values["status-file"],
			callbackFile: values["callback-file"],
			signal: controller.signal,
		});
	} else if (positionals[0] === "run") {
		const bootToken = process.env.ZUSE_REVIEW_BOOT_TOKEN;
		delete process.env.ZUSE_REVIEW_BOOT_TOKEN;
		if (!values["attempt-id"] || !values["api-origin"] || !bootToken)
			throw new Error("Review worker bootstrap required");
		await runNativeWorkerRuntime({
			apiOrigin: values["api-origin"],
			attemptId: values["attempt-id"],
			bootToken,
			executablePath,
			workRoot: "/run/zuse-review-work",
			workerExecutable: "/opt/zuse/review-worker.mjs",
			signal: controller.signal,
		});
	} else throw new Error("Expected login or run");
} catch {
	// Never print exception messages/native output containing credentials or source.
	process.stderr.write("Review worker stopped without confirmed completion\n");
	process.stdin.destroy();
	process.exitCode = 1;
}
