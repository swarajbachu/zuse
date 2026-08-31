import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const isRendererOwner = (path) =>
	/^apps\/renderer\/src\/(?:components|hooks|shell|state|store)\//u.test(path);

const rule = (id, description, owns, patterns, exclude = () => false) => ({
	id,
	description,
	exclude,
	owns,
	patterns,
});

/**
 * These rules intentionally match architectural ownership, rather than private
 * helper names or complete syntax trees. Existing violations are held behind a
 * per-file ratchet in architecture-boundary-baseline.json. The baseline is
 * generated from origin/main, so debt may disappear but cannot move into a new
 * owner or grow in an existing owner. New categories start at zero.
 */
export const architectureRules = [
	rule(
		"renderer-raw-rpc",
		"Renderer surfaces must dispatch through ClientBus instead of owning RPC clients.",
		isRendererOwner,
		[/\b(?:getRpcClient|getControlPlaneRpcClient)\s*\(/u],
	),
	rule(
		"renderer-stream-owner",
		"Renderer surfaces must not own long-lived stream fibers or retry loops.",
		isRendererOwner,
		[
			/\bStream\.run(?:Drain|ForEach|Fork)\s*\(/u,
			/\b(?:Effect|Runtime)\.runFork\s*\(/u,
		],
	),
	rule(
		"renderer-client-bus-legacy-supervisor",
		"ClientBus adapters must acquire passive sessions instead of the legacy renderer connection supervisor.",
		(path) => /^apps\/renderer\/src\/lib\/.*client-bus\.ts$/u.test(path),
		[
			/\b(?:getRpcClient|subscribeRendererRpcConnection|retryRendererRpcConnection|releaseRpcClient)\b/u,
		],
	),
	rule(
		"unqualified-resource-ref",
		"Environment-scoped work must use a qualified resource reference.",
		(path) =>
			isRendererOwner(path) || /^packages\/client-runtime\/src\//u.test(path),
		[
			/\bgetRpcClient\s*\(\s*\)/u,
			/\bscopedCacheKey\s*\(/u,
			/\b(?:cacheKey|resourceKey|terminalRuntimeKey)\s*\(\s*(?:sessionId|projectId|chatId|terminalId)\s*[,)]/u,
		],
	),
	rule(
		"cloud-chat-pipeline",
		"Cloud capability must not introduce a second chat or execution data plane.",
		(path) =>
			/^(?:apps\/(?:renderer|server)|infra\/api|packages\/contracts)\/src\//u.test(
				path,
			),
		[
			/\bcloud\.chats\.(?:history|send|rename)\b/u,
			/\bCloudChat(?:Event|History|QueuedMessage|Command)\b/u,
			/["'][^"']*cloud-chat(?:s|-registry|-connection|-store)[^"']*["']/u,
		],
	),
	rule(
		"session-domain-bypass",
		"Transcript, turn, and queue writes must pass through SessionDomain.",
		(path) => /^apps\/server\/src\//u.test(path),
		[
			/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:sessions|messages|queued_messages|session_events|session_command_receipts)\b/iu,
		],
		(path) =>
			/^apps\/server\/src\/persistence\/(?:migrations|backfill(?:-verifier)?\.ts)/u.test(
				path,
			),
	),
	rule(
		"api-message-content",
		"API schemas may carry content only in the named one-shot launch intent.",
		(path) => /^(?:infra\/api|packages\/contracts)\/src\//u.test(path),
		[
			/\bfirstMessage\b/u,
			/\bchat_metadata_ciphertext\b/u,
			/\bapi_cloud_workspace_(?:commands|events)\b/u,
			/\bCloudChats(?:History|Send|Rename)Rpc\b/u,
			/\bCloudChat(?:Event|History|QueuedMessage|Command)\b/u,
		],
		(path, line) =>
			/cloud-workspace-launch-intent\.ts$/u.test(path) ||
			(path === "packages/contracts/src/cloud-workspaces.ts" &&
				/^\s*firstMessage:\s*Schema\.optional\(Schema\.String\),?\s*$/u.test(
					line,
				)),
	),
];

const sourceFiles = (root) => {
	const files = [];
	const visit = (directory) => {
		if (!existsSync(directory)) return;
		for (const name of readdirSync(directory)) {
			if (name === "dist" || name === "node_modules" || name === ".git")
				continue;
			const absolute = join(directory, name);
			if (statSync(absolute).isDirectory()) {
				visit(absolute);
			} else if (SOURCE_EXTENSIONS.has(extname(absolute))) {
				files.push(absolute);
			}
		}
	};
	for (const directory of ["apps", "infra", "packages"]) {
		visit(join(root, directory));
	}
	return files;
};

export const violationsForSource = (path, source) => {
	const violations = [];
	const lines = source.split(/\r?\n/u);
	for (const candidate of architectureRules) {
		if (!candidate.owns(path)) continue;
		for (const [index, line] of lines.entries()) {
			if (candidate.exclude(path, line)) continue;
			for (const pattern of candidate.patterns) {
				if (!pattern.test(line)) continue;
				violations.push({
					rule: candidate.id,
					path,
					line: index + 1,
					text: line.trim(),
				});
				break;
			}
		}
	}
	return violations;
};

export const scanArchitectureBoundaries = (root) =>
	sourceFiles(root).flatMap((absolute) => {
		const path = relative(root, absolute).replaceAll("\\", "/");
		return violationsForSource(path, readFileSync(absolute, "utf8"));
	});

export const summarizeViolations = (violations) =>
	Object.fromEntries(
		architectureRules.map(({ id }) => [
			id,
			violations.filter((violation) => violation.rule === id).length,
		]),
	);

export const violationsByRuleAndFile = (violations) => {
	const result = Object.fromEntries(
		architectureRules.map(({ id }) => [id, {}]),
	);
	for (const violation of violations) {
		const files = result[violation.rule];
		files[violation.path] = (files[violation.path] ?? 0) + 1;
	}
	return result;
};

export const architectureRegressions = (violations, baseline) =>
	architectureRules.flatMap(({ id, description }) => {
		const allowedFiles = baseline.rules[id];
		if (allowedFiles === null || typeof allowedFiles !== "object") {
			return [`${id}: baseline is missing per-file budgets`];
		}
		const actualFiles = violationsByRuleAndFile(violations)[id];
		const totalMaximum = baseline.maximumTotals?.[id];
		const total = Object.values(actualFiles).reduce(
			(sum, count) => sum + count,
			0,
		);
		const totalRegressions =
			typeof totalMaximum === "number" && total > totalMaximum
				? [
						`${id}: has ${total} total violations, budget ${totalMaximum} — ${description}`,
					]
				: [];
		return totalRegressions.concat(
			Object.entries(actualFiles).flatMap(([path, actual]) => {
				const approvedIncrease = baseline.approvedInFlight?.[id]?.[path] ?? 0;
				const maximum = (allowedFiles[path] ?? 0) + approvedIncrease;
				return actual > maximum
					? [
							`${id}: ${path} has ${actual} violations, budget ${maximum} — ${description}`,
						]
					: [];
			}),
		);
	});

const renderReport = (violations) => {
	for (const candidate of architectureRules) {
		const matching = violations.filter(({ rule: id }) => id === candidate.id);
		console.log(`\n${candidate.id} (${matching.length})`);
		console.log(candidate.description);
		for (const violation of matching) {
			console.log(`  ${violation.path}:${violation.line}  ${violation.text}`);
		}
	}
};

const run = () => {
	const root = resolve(import.meta.dirname, "..");
	const baselinePath = join(
		root,
		"scripts",
		"architecture-boundary-baseline.json",
	);
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const violations = scanArchitectureBoundaries(root);
	const summary = summarizeViolations(violations);
	const regressions = architectureRegressions(violations, baseline);

	if (process.argv.includes("--report")) renderReport(violations);
	if (regressions.length > 0) {
		console.error(
			`Architecture boundary regressions:\n${regressions.map((item) => `- ${item}`).join("\n")}\n\nRun "bun run check:architecture --report" for exact locations.`,
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		`Architecture boundaries passed (${Object.entries(summary)
			.map(([id, count]) => `${id}=${count}`)
			.join(", ")}).`,
	);
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) run();
