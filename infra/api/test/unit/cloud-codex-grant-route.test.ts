import { describe, expect, test } from "vitest";
import {
	codexGrantRuntimeBindingError,
	providerGrantRuntimeBindingError,
} from "../../src/cloud-workspace-routes.ts";
import type { CloudWorkspaceRecord } from "../../src/cloud-workspace-store.ts";

const workspace = (
	overrides: Record<string, unknown> = {},
): CloudWorkspaceRecord => ({
	workspaceId: "workspace-1",
	accountId: "account-1",
	projectId: "project-1",
	buildId: "image-1",
	provider: "e2b",
	runtimeState: "online",
	chatId: "chat-1",
	initialSessionId: "session-1",
	branch: "main",
	baseRef: "main",
	state: "ready",
	desiredState: "ready",
	statusCode: "agent-running",
	idempotencyKey: "create-1",
	requestConfig: {
		codexAuthMode: "broker-v1",
		runtimeGeneration: 4,
		runtimeBootstrapReceipt: {
			workspaceId: "workspace-1",
			bootTokenHash: "boot",
			credentialKeyThumbprint: "runtime-key",
			signingKeyThumbprint: "signing-key",
			signingPublicJwk: "{}",
			runtimeCredentialHash: "credential",
			runtimeCredentialExpiresAtMs: 10_000,
			generation: 4,
			gatewayEpoch: 4,
			sealedTranscriptKey: "sealed",
			enrolledAtMs: 1,
		},
		...overrides,
	},
	nextActionAtMs: 10_000,
	revision: 1,
	createdAtMs: 1,
	updatedAtMs: 1,
	lastActivityAtMs: 1,
});

describe("Codex runtime grant binding", () => {
	test("accepts only the enrolled generation and RSA key", () => {
		expect(
			codexGrantRuntimeBindingError(
				workspace(),
				{ runtimeGeneration: 4 },
				"runtime-key",
			),
		).toBeNull();
		expect(
			codexGrantRuntimeBindingError(
				workspace(),
				{ runtimeGeneration: 5 },
				"runtime-key",
			),
		).toBe("workspace_runtime_fenced");
		expect(
			codexGrantRuntimeBindingError(
				workspace(),
				{ runtimeGeneration: 4 },
				"attacker-key",
			),
		).toBe("runtime_credential_key_binding_mismatch");
	});

	test("never upgrades a retained workspace without an immutable marker", () => {
		expect(
			codexGrantRuntimeBindingError(
				workspace({ codexAuthMode: undefined }),
				{ runtimeGeneration: 4 },
				"runtime-key",
			),
		).toBe("codex-auth-legacy-workspace");
	});
});

describe("provider runtime grant binding", () => {
	test("uses a separate immutable provider capability", () => {
		expect(
			providerGrantRuntimeBindingError(
				workspace({ providerAuthMode: "broker-v1" }),
				{ runtimeGeneration: 4 },
				"runtime-key",
			),
		).toBeNull();
		expect(
			providerGrantRuntimeBindingError(
				workspace({ providerAuthMode: undefined }),
				{ runtimeGeneration: 4 },
				"runtime-key",
			),
		).toBe("provider-auth-legacy-workspace");
	});
});
