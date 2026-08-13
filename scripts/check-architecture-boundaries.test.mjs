import assert from "node:assert/strict";
import test from "node:test";

import {
	architectureRegressions,
	summarizeViolations,
	violationsForSource,
} from "./check-architecture-boundaries.mjs";

const count = (path, source, rule) =>
	summarizeViolations(violationsForSource(path, source))[rule];

test("detects raw renderer RPC ownership", () => {
	assert.equal(
		count(
			"apps/renderer/src/components/example.tsx",
			'import { getRpcClient } from "../lib/rpc-client.ts";\nconst rpc = getRpcClient(environmentId);',
			"renderer-raw-rpc",
		),
		1,
	);
	assert.equal(
		count(
			"apps/renderer/src/lib/environment-runtime.ts",
			'import { getRpcClient } from "./rpc-client.ts";',
			"renderer-raw-rpc",
		),
		0,
	);
});
test("detects stream ownership and ambient resource lookup", () => {
	const source =
		"const key = cacheKey(sessionId);\nStream.runForEach(stream, consume);";
	assert.equal(
		count(
			"apps/renderer/src/store/example.ts",
			source,
			"renderer-stream-owner",
		),
		1,
	);
	assert.equal(
		count(
			"apps/renderer/src/store/example.ts",
			source,
			"unqualified-resource-ref",
		),
		1,
	);
});

test("keeps ClientBus adapters off the legacy renderer supervisor", () => {
	assert.equal(
		count(
			"apps/renderer/src/lib/example-client-bus.ts",
			'import { getRpcClient } from "./rpc-client.ts";',
			"renderer-client-bus-legacy-supervisor",
		),
		1,
	);
	assert.equal(
		count(
			"apps/renderer/src/store/legacy.ts",
			'import { getRpcClient } from "../lib/rpc-client.ts";',
			"renderer-client-bus-legacy-supervisor",
		),
		0,
	);
});

test("detects the legacy cloud chat data plane", () => {
	assert.equal(
		count(
			"packages/contracts/src/example.ts",
			'Rpc.make("cloud.chats.send", { success: CloudChatHistory });',
			"cloud-chat-pipeline",
		),
		1,
	);
});

test("detects direct server transcript writes but excludes migrations", () => {
	const statement = "yield* sql`UPDATE sessions SET status = 'idle'`;";
	assert.equal(
		count(
			"apps/server/src/conversation/example.ts",
			statement,
			"session-domain-bypass",
		),
		1,
	);
	assert.equal(
		count(
			"apps/server/src/persistence/migrations/0047_example.ts",
			statement,
			"session-domain-bypass",
		),
		0,
	);
});

test("allows Relay content only in the named launch-intent module", () => {
	const source = "firstMessage: Schema.String";
	assert.equal(
		count(
			"infra/relay/src/cloud-workspace-routes.ts",
			source,
			"relay-message-content",
		),
		1,
	);
	assert.equal(
		count(
			"infra/relay/src/cloud-workspace-launch-intent.ts",
			source,
			"relay-message-content",
		),
		0,
	);
	assert.equal(
		count(
			"packages/contracts/src/cloud-workspaces.ts",
			"firstMessage: Schema.optional(Schema.String)",
			"relay-message-content",
		),
		0,
	);
	assert.equal(
		count(
			"packages/contracts/src/cloud-workspaces.ts",
			"const firstMessage = plaintext;",
			"relay-message-content",
		),
		1,
	);
	assert.equal(
		count(
			"packages/contracts/src/cloud-workspaces.ts",
			"export const CloudChatsSendRpc = {};",
			"relay-message-content",
		),
		1,
	);
	assert.equal(
		count(
			"packages/contracts/src/cloud-workspaces.ts",
			"export class CloudChatEvent {}",
			"relay-message-content",
		),
		1,
	);
	assert.equal(
		count(
			"infra/relay/src/cloud-workspace-routes.ts",
			'import { CloudWorkspaceLaunchIntent } from "./cloud-workspace-launch-intent.ts";',
			"relay-message-content",
		),
		0,
	);
});

test("ratchets every rule and rejects missing budgets", () => {
	const violations = [
		{
			rule: "renderer-raw-rpc",
			path: "apps/renderer/src/components/new-owner.tsx",
			line: 1,
			text: "getRpcClient()",
		},
	];
	const baseline = {
		rules: Object.fromEntries(
			Object.keys(summarizeViolations([])).map((id) => [id, {}]),
		),
	};
	assert.match(
		architectureRegressions(violations, baseline).join("\n"),
		/renderer-raw-rpc: apps\/renderer\/src\/components\/new-owner\.tsx has 1 violations, budget 0/u,
	);
	baseline.approvedInFlight = {
		"renderer-raw-rpc": {
			"apps/renderer/src/components/new-owner.tsx": 1,
		},
	};
	assert.deepEqual(architectureRegressions(violations, baseline), []);
	delete baseline.rules["relay-message-content"];
	assert.match(
		architectureRegressions(violations, baseline).join("\n"),
		/relay-message-content: baseline is missing per-file budgets/u,
	);
});

test("global zero budgets prevent deleted architecture from returning", () => {
	const violations = [
		{
			rule: "renderer-stream-owner",
			path: "apps/renderer/src/store/auth.ts",
			line: 1,
			text: "Effect.runFork(stream)",
		},
	];
	const baseline = {
		rules: Object.fromEntries(
			Object.keys(summarizeViolations([])).map((id) => [id, {}]),
		),
		maximumTotals: { "renderer-stream-owner": 0 },
	};
	assert.match(
		architectureRegressions(violations, baseline).join("\n"),
		/renderer-stream-owner: has 1 total violations, budget 0/u,
	);
});
