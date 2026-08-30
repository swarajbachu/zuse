import {
	type CloudAuthConfigureRequest,
	CloudAuthLoginOperation,
	type CloudAuthProvider,
	CloudAuthProviderStatus,
	CloudAuthStatus,
} from "@zuse/contracts";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Effect, Schedule } from "effect";

import { ApiConfiguration } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { badRequest, serviceUnavailable } from "./errors.ts";

const AUTH_HOME = "/home/zuse/.zuse/cloud-auth";
const AUTH_PUBLIC_JWK = `${AUTH_HOME}/public.jwk.json`;
const AUTH_KEY_ID = `${AUTH_HOME}/key-id`;
const AUTH_BOOTSTRAP_HOME = `${AUTH_HOME}/bootstrap`;
const AUTH_INITIALIZER = `${AUTH_BOOTSTRAP_HOME}/initialize.mjs`;
const AUTH_CONFIGURATOR = `${AUTH_BOOTSTRAP_HOME}/configure.mjs`;
const AUTH_LOGIN = `${AUTH_BOOTSTRAP_HOME}/login.mjs`;
const AUTH_CANCEL = `${AUTH_BOOTSTRAP_HOME}/cancel.mjs`;
const AUTH_VERIFY = `${AUTH_BOOTSTRAP_HOME}/verify.mjs`;
const AUTH_TIMEOUT_SECONDS = 60 * 60;
const PROVIDERS = ["claude", "codex", "cursor", "grok"] as const;
const AUTH_STARTUP_RETRY = Schedule.addDelay(Schedule.recurs(20), () =>
	Effect.succeed("250 millis"),
);

export const parseDeviceLoginOutput = (
	output: string,
): {
	readonly verificationUrl?: string;
	readonly verificationCode?: string;
} => {
	const escapeCharacter = String.fromCharCode(27);
	const bell = String.fromCharCode(7);
	const plain = output
		.replace(
			new RegExp(
				`${escapeCharacter}\\][^${bell}]*(?:${bell}|${escapeCharacter}\\\\)`,
				"gu",
			),
			"",
		)
		.replace(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
		.replace(/\r/gu, "");
	const verificationUrl = plain
		.match(/https?:\/\/[^\s<>"']+/u)?.[0]
		?.replace(/[),.;]+$/u, "");
	const labeledCode = plain.match(
		/(?:enter\s+this\s+)?(?:one-time|device|verification|user)\s+code(?:\s*\([^\n)]*\))?(?:\s*[:=]\s*|\s*\n\s*)([A-Z0-9][A-Z0-9-]{3,31})\b/iu,
	)?.[1];
	const standaloneCode = plain.match(
		/(?:^|\n)\s*(?:CODE\s*:\s*)?((?=[A-Z0-9-]{4,32}\s*(?:\n|$))(?=[A-Z0-9-]*[0-9-])[A-Z0-9][A-Z0-9-]{3,31})\s*(?=\n|$)/mu,
	)?.[1];
	const candidate = labeledCode ?? standaloneCode;
	const verificationCode =
		candidate === undefined ? undefined : candidate.toUpperCase();
	return {
		...(verificationUrl === undefined ? {} : { verificationUrl }),
		...(verificationCode === undefined ? {} : { verificationCode }),
	};
};

const INITIALIZER_SOURCE = `import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
const home = "/home/zuse/.zuse/cloud-auth";
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(home + "/operations", { recursive: true, mode: 0o700 });
mkdirSync(home + "/providers", { recursive: true, mode: 0o700 });
mkdirSync(home + "/status", { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);
const privatePath = home + "/private.pem";
const publicPath = home + "/public.jwk.json";
if (!existsSync(privatePath) || !existsSync(publicPath)) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  writeFileSync(privatePath, privatePem, { mode: 0o600 });
  writeFileSync(publicPath, JSON.stringify(publicJwk), { mode: 0o644 });
}
const publicJwk = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(publicPath, "utf8")));
const keyId = createHash("sha256").update(JSON.stringify(publicJwk)).digest("base64url");
writeFileSync(home + "/key-id", keyId, { mode: 0o644 });
`;

const CONFIGURATOR_SOURCE = String.raw`import { constants, privateDecrypt } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const home = "/home/zuse/.zuse/cloud-auth";
const requestPath = process.argv[2];
const resultPath = process.argv[3];
const input = JSON.parse(await readFile(requestPath, "utf8"));
const keyId = (await readFile(home + "/key-id", "utf8")).trim();
if (input.sealedSecret.keyId !== keyId) throw new Error("stale_encryption_key");
const privateKey = await readFile(home + "/private.pem", "utf8");
const secret = privateDecrypt({ key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(input.sealedSecret.ciphertext, "base64url")).toString("utf8").trim();
if (secret.length < 8 || secret.length > 32768 || /[\r\n\0]/u.test(secret)) throw new Error("invalid_credential");
const command = input.providerId === "cursor" ? "cursor-agent" : input.providerId;
const statusArgs = input.providerId === "claude" ? ["auth", "status", "--json"] : input.providerId === "codex" ? ["login", "status"] : input.providerId === "cursor" ? ["status"] : ["models"];
const env = { ...process.env };
if (input.providerId === "claude") env[input.method === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = secret;
if (input.providerId === "codex") env.OPENAI_API_KEY = secret;
if (input.providerId === "cursor") env.CURSOR_API_KEY = secret;
if (input.providerId === "grok") { env.XAI_API_KEY = secret; env.GROK_CODE_XAI_API_KEY = secret; }
const run = (args, stdin) => new Promise((resolve) => {
  const child = spawn(command, args, { env, stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
  child.once("error", (error) => { clearTimeout(timer); resolve({ code: 127, error: error.code === "ENOENT" ? "missing-tool" : "launch-failed" }); });
  child.once("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 1 }); });
  if (stdin !== undefined) child.stdin.end(stdin + "\n");
});
if (input.providerId === "codex" && input.method === "api-key") {
  const login = await run(["login", "--with-api-key"], secret);
  if (login.code !== 0) {
    await writeFile(resultPath, JSON.stringify({ state: login.error === "missing-tool" ? "missing-tool" : "error", errorCode: login.error ?? "login-failed" }), { mode: 0o600 });
    process.exit(0);
  }
}
const status = await run(statusArgs);
if (status.code === 0) {
  await mkdir(home + "/providers", { recursive: true, mode: 0o700 });
  const credentialPath = home + "/providers/" + input.providerId + ".json";
  await writeFile(credentialPath, JSON.stringify({ providerId: input.providerId, method: input.method, secret, baseUrl: input.baseUrl, modelProvider: input.modelProvider, updatedAt: Date.now() }), { mode: 0o600 });
  await chmod(credentialPath, 0o600);
  await mkdir("/home/zuse/.zuse-image", { recursive: true, mode: 0o700 });
  const imageSecretsPath = "/home/zuse/.zuse-image/provider-secrets.json";
  let imageSecrets = {};
  try { imageSecrets = JSON.parse(await readFile(imageSecretsPath, "utf8")); } catch {}
  imageSecrets[input.providerId] = { method: input.method, secret, baseUrl: input.baseUrl, modelProvider: input.modelProvider };
  await writeFile(imageSecretsPath, JSON.stringify(imageSecrets), { mode: 0o600 });
  await chmod(imageSecretsPath, 0o600);
}
const result = { state: status.code === 0 ? "connected" : status.error === "missing-tool" ? "missing-tool" : "expired", method: input.method, verifiedAt: status.code === 0 ? Date.now() : undefined, errorCode: status.code === 0 ? undefined : status.error ?? "verification-failed" };
await writeFile(home + "/status/" + input.providerId + ".json", JSON.stringify(result), { mode: 0o600 });
await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 });
`;

const LOGIN_SOURCE = `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const parseDeviceLoginOutput = ${parseDeviceLoginOutput.toString()};
const home = "/home/zuse/.zuse/cloud-auth";
const providerId = process.argv[2];
const operationId = process.argv[3];
const operationPath = home + "/operations/" + operationId + ".json";
await mkdir(home + "/operations", { recursive: true, mode: 0o700 });
const command = providerId === "cursor" ? "cursor-agent" : providerId;
const args = ["login", "--device-auth"];
const child = spawn(command, args, { cwd: "/home/zuse", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
await writeFile(operationPath, JSON.stringify({ providerId, state: "authorizing", pid: child.pid }), { mode: 0o600 });
let output = "";
const update = async () => {
  const parsed = parseDeviceLoginOutput(output);
  await writeFile(operationPath, JSON.stringify({ providerId, state: "authorizing", pid: child.pid, ...parsed }), { mode: 0o600 });
};
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); void update(); });
child.once("error", async (error) => { await writeFile(operationPath, JSON.stringify({ providerId, state: "error", errorCode: error.code === "ENOENT" ? "missing-tool" : "login-failed" }), { mode: 0o600 }); });
child.once("exit", async (code) => {
  if (code === 0) {
    await mkdir(home + "/providers", { recursive: true, mode: 0o700 });
    await writeFile(home + "/providers/" + providerId + ".json", JSON.stringify({ providerId, method: "subscription", native: true, updatedAt: Date.now() }), { mode: 0o600 });
    await writeFile(home + "/status/" + providerId + ".json", JSON.stringify({ providerId, method: "subscription", native: true, state: "connected", verifiedAt: Date.now() }), { mode: 0o600 });
  }
  await writeFile(operationPath, JSON.stringify({ providerId, state: code === 0 ? "connected" : "error", errorCode: code === 0 ? undefined : "login-failed" }), { mode: 0o600 });
});
`;

const CANCEL_SOURCE = `import { readFile, writeFile } from "node:fs/promises";
const path = process.argv[2];
const current = JSON.parse(await readFile(path, "utf8"));
if (typeof current.pid === "number") { try { process.kill(current.pid, "SIGTERM"); } catch {} }
await writeFile(path, JSON.stringify({ providerId: current.providerId, state: "cancelled" }), { mode: 0o600 });
`;

const VERIFY_SOURCE = `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const home = "/home/zuse/.zuse/cloud-auth";
const markerPath = process.argv[2];
const providers = ["claude", "codex", "cursor", "grok"];
const verify = async (providerId) => {
  let credential;
  try { credential = JSON.parse(await readFile(home + "/providers/" + providerId + ".json", "utf8")); } catch { return; }
  const command = providerId === "cursor" ? "cursor-agent" : providerId;
  const args = providerId === "claude" ? ["auth", "status", "--json"] : providerId === "codex" ? ["login", "status"] : providerId === "cursor" ? ["status"] : ["models"];
  const env = { ...process.env };
  if (credential.native !== true) {
    if (providerId === "claude") env[credential.method === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = credential.secret;
    if (providerId === "codex") env.OPENAI_API_KEY = credential.secret;
    if (providerId === "cursor") env.CURSOR_API_KEY = credential.secret;
    if (providerId === "grok") { env.XAI_API_KEY = credential.secret; env.GROK_CODE_XAI_API_KEY = credential.secret; }
  }
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: 127, error: error.code === "ENOENT" ? "missing-tool" : "verification-failed" }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 1 }); });
  });
  const state = result.code === 0 ? "connected" : result.error === "missing-tool" ? "missing-tool" : "expired";
  await writeFile(home + "/status/" + providerId + ".json", JSON.stringify({ providerId, method: credential.method, native: credential.native === true, state, verifiedAt: result.code === 0 ? credential.updatedAt ?? Date.now() : undefined, errorCode: result.code === 0 ? undefined : result.error ?? "verification-failed" }), { mode: 0o600 });
};
await mkdir(home + "/status", { recursive: true, mode: 0o700 });
await Promise.all(providers.map(verify));
await writeFile(markerPath, "ready", { mode: 0o600 });
`;

type Authority = {
	readonly provider: SandboxProviderAdapter;
	readonly sandboxId: string;
	readonly state: "running" | "paused";
};

export const cloudAuthAuthorityLabel = (input: {
	readonly accountId: string;
	readonly apiIssuer: string;
	readonly templateVersion: string;
}) =>
	sha256Hex(
		`cloud-auth-authority-v2:${input.apiIssuer}:${input.templateVersion}:${input.accountId}`,
	).pipe(Effect.map((digest) => `zuse-auth-${digest.slice(0, 32)}`));

const authorityLabel = (accountId: string, provider: SandboxProviderAdapter) =>
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		return yield* cloudAuthAuthorityLabel({
			accountId,
			apiIssuer: config.apiIssuer,
			templateVersion: provider.templateVersion,
		});
	});

const e2bProvider = Effect.gen(function* () {
	const providers = yield* SandboxProviders;
	return yield* providers
		.get("e2b")
		.pipe(
			Effect.mapError(() => serviceUnavailable("cloud_auth_e2b_unavailable")),
		);
});

const recoverAuthority = Effect.fn("recoverCloudAuthAuthority")(function* (
	accountId: string,
) {
	const provider = yield* e2bProvider;
	const label = yield* authorityLabel(accountId, provider);
	const sandbox = yield* provider
		.recoverByLabel(label)
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_unavailable")));
	return sandbox === null
		? null
		: ({
				provider,
				sandboxId: sandbox.providerSandboxId,
				state: sandbox.state,
			} satisfies Authority);
});

const readOptional = (
	authority: Authority,
	path: string,
): Effect.Effect<string | null, never> =>
	authority.provider.readTextFile(authority.sandboxId, path, "zuse").pipe(
		Effect.map((value) => value.trim()),
		Effect.orElseSucceed(() => null),
	);

const waitForFile = Effect.fn("waitForCloudAuthFile")(function* (
	authority: Authority,
	path: string,
	attempts = 100,
) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const value = yield* readOptional(authority, path);
		if (value !== null && value.length > 0) return value;
		yield* Effect.sleep("100 millis");
	}
	return yield* Effect.fail(serviceUnavailable("cloud_auth_operation_timeout"));
});

const initializeAuthority = Effect.fn("initializeCloudAuthAuthority")(
	function* (authority: Authority) {
		yield* Effect.forEach(
			[
				[AUTH_INITIALIZER, INITIALIZER_SOURCE],
				[AUTH_CONFIGURATOR, CONFIGURATOR_SOURCE],
				[AUTH_LOGIN, LOGIN_SOURCE],
				[AUTH_CANCEL, CANCEL_SOURCE],
				[AUTH_VERIFY, VERIFY_SOURCE],
			] as const,
			([path, contents]) =>
				authority.provider
					.writeTextFile(authority.sandboxId, path, contents, "zuse")
					.pipe(Effect.retry(AUTH_STARTUP_RETRY)),
			{ concurrency: 4 },
		).pipe(
			Effect.tapError((cause) =>
				Effect.sync(() =>
					console.warn("[cloud-auth] bootstrap upload failed", {
						sandboxId: authority.sandboxId,
						providerCode: cause.code,
					}),
				),
			),
			Effect.mapError(() => serviceUnavailable("cloud_auth_initialize_failed")),
		);
		yield* authority.provider
			.startProcess(authority.sandboxId, {
				command: "node",
				args: [AUTH_INITIALIZER],
				user: "zuse",
				tag: "zuse-cloud-auth-initialize",
			})
			.pipe(
				Effect.retry(AUTH_STARTUP_RETRY),
				Effect.tapError((cause) =>
					Effect.sync(() =>
						console.warn("[cloud-auth] initialization failed", {
							sandboxId: authority.sandboxId,
							providerCode: cause.code,
						}),
					),
				),
				Effect.mapError(() =>
					serviceUnavailable("cloud_auth_initialize_failed"),
				),
			);
		yield* waitForFile(authority, AUTH_KEY_ID);
		return authority;
	},
);

const ensureRunning = Effect.fn("ensureCloudAuthAuthorityRunning")(function* (
	authority: Authority,
) {
	if (authority.state === "running") return authority;
	const resumed = yield* authority.provider
		.resume(authority.sandboxId, AUTH_TIMEOUT_SECONDS, "pause")
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_unavailable")));
	return { ...authority, state: resumed.state } satisfies Authority;
});

const provisionAuthority = Effect.fn("provisionCloudAuthAuthority")(function* (
	accountId: string,
) {
	const recovered = yield* recoverAuthority(accountId);
	if (recovered !== null)
		return yield* initializeAuthority(yield* ensureRunning(recovered));
	const provider = yield* e2bProvider;
	const label = yield* authorityLabel(accountId, provider);
	const sandboxId = `auth_${(yield* sha256Hex(`${accountId}:${crypto.randomUUID()}`)).slice(0, 24)}`;
	const created = yield* provider
		.create({
			sandboxId,
			providerLabel: label,
			metadata: { "zuse-purpose": "account-auth-authority" },
			timeoutSeconds: AUTH_TIMEOUT_SECONDS,
			env: {},
			network: { kind: "open" },
			onTimeout: "pause",
		})
		.pipe(
			Effect.tapError((cause) =>
				Effect.sync(() =>
					console.warn("[cloud-auth] sandbox creation failed", {
						providerCode: cause.code,
					}),
				),
			),
			Effect.mapError(() => serviceUnavailable("cloud_auth_provision_failed")),
		);
	return yield* initializeAuthority({
		provider,
		sandboxId: created.providerSandboxId,
		state: created.state,
	});
});

const decodeProviderStatus = (
	providerId: CloudAuthProvider,
	value: string | null,
): CloudAuthProviderStatus => {
	if (value === null) {
		return new CloudAuthProviderStatus({ providerId, state: "disconnected" });
	}
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const method =
			parsed.method === "subscription" ||
			parsed.method === "api-key" ||
			parsed.method === "custom"
				? parsed.method
				: undefined;
		const state =
			parsed.state === "disconnected" ||
			parsed.state === "connected" ||
			parsed.state === "expired" ||
			parsed.state === "missing-tool" ||
			parsed.state === "error"
				? parsed.state
				: "error";
		return new CloudAuthProviderStatus({
			providerId,
			state,
			...(method === undefined ? {} : { method }),
			...(typeof parsed.verifiedAt === "number"
				? { verifiedAt: parsed.verifiedAt }
				: {}),
		});
	} catch {
		return new CloudAuthProviderStatus({
			providerId,
			state: "error",
			errorCode: "invalid-authority-state",
		});
	}
};

const readCloudAuthStatus = Effect.fn("readCloudAuthStatus")(function* (
	accountId: string,
	verify: boolean,
) {
	const recovered = yield* recoverAuthority(accountId);
	if (recovered === null) {
		return new CloudAuthStatus({
			authorityState: "not-created",
			providers: PROVIDERS.map(
				(providerId) =>
					new CloudAuthProviderStatus({
						providerId,
						state: "disconnected",
					}),
			),
		});
	}
	const authority = yield* initializeAuthority(yield* ensureRunning(recovered));
	if (verify) {
		const verificationId = crypto.randomUUID();
		const verificationMarker = `${AUTH_HOME}/operations/verify-${verificationId}.done`;
		yield* authority.provider
			.startProcess(authority.sandboxId, {
				command: "node",
				args: [AUTH_VERIFY, verificationMarker],
				user: "zuse",
				tag: `zuse-cloud-auth-verify-${verificationId}`,
			})
			.pipe(Effect.ignore);
		yield* waitForFile(authority, verificationMarker, 350).pipe(Effect.ignore);
	}
	const [keyId, publicJwk, providerValues] = yield* Effect.all(
		[
			readOptional(authority, AUTH_KEY_ID),
			readOptional(authority, AUTH_PUBLIC_JWK),
			Effect.all(
				PROVIDERS.map((providerId) =>
					readOptional(authority, `${AUTH_HOME}/status/${providerId}.json`),
				),
				{ concurrency: 4 },
			),
		] as const,
		{ concurrency: 3 },
	);
	return new CloudAuthStatus({
		authorityState: keyId === null || publicJwk === null ? "error" : "ready",
		providers: PROVIDERS.map((providerId, index) =>
			decodeProviderStatus(providerId, providerValues[index] ?? null),
		),
		...(keyId === null ? {} : { encryptionKeyId: keyId }),
		...(publicJwk === null ? {} : { encryptionPublicJwk: publicJwk }),
		updatedAt: Date.now(),
	});
});

/** Read the last real CLI verification without putting provider probes on UI polling. */
export const cloudAuthStatus = Effect.fn("cloudAuthStatus")(function* (
	accountId: string,
) {
	return yield* readCloudAuthStatus(accountId, false).pipe(
		Effect.catch((cause) =>
			Effect.sync(() => {
				console.warn("[cloud-auth] status unavailable", {
					accountId,
					code: cause.code,
				});
				return new CloudAuthStatus({
					authorityState: "error",
					providers: PROVIDERS.map(
						(providerId) =>
							new CloudAuthProviderStatus({
								providerId,
								state: "disconnected",
							}),
					),
					updatedAt: Date.now(),
				});
			}),
		),
	);
});

export const provisionCloudAuth = Effect.fn("provisionCloudAuth")(function* (
	accountId: string,
) {
	yield* provisionAuthority(accountId);
	return yield* cloudAuthStatus(accountId);
});

const operationFrom = (
	operationId: string,
	value: string,
): CloudAuthLoginOperation => {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const providerId = PROVIDERS.includes(
			parsed.providerId as CloudAuthProvider,
		)
			? (parsed.providerId as CloudAuthProvider)
			: "codex";
		const state =
			parsed.state === "connected" ||
			parsed.state === "error" ||
			parsed.state === "cancelled"
				? parsed.state
				: "authorizing";
		return new CloudAuthLoginOperation({
			operationId,
			providerId,
			state,
			...(typeof parsed.verificationUrl === "string"
				? { verificationUrl: parsed.verificationUrl }
				: {}),
			...(typeof parsed.verificationCode === "string"
				? { verificationCode: parsed.verificationCode }
				: {}),
			...(typeof parsed.errorCode === "string"
				? { errorCode: parsed.errorCode }
				: {}),
		});
	} catch {
		return new CloudAuthLoginOperation({
			operationId,
			providerId: "codex",
			state: "error",
			errorCode: "invalid-operation-state",
		});
	}
};

export const configureCloudAuth = Effect.fn("configureCloudAuth")(function* (
	accountId: string,
	request: CloudAuthConfigureRequest,
) {
	if (
		request.baseUrl !== undefined &&
		(() => {
			try {
				return new URL(request.baseUrl).protocol !== "https:";
			} catch {
				return true;
			}
		})()
	)
		return yield* Effect.fail(badRequest("invalid_cloud_auth_base_url"));
	const authority = yield* ensureRunning(yield* provisionAuthority(accountId));
	const operationId = crypto.randomUUID();
	const requestPath = `${AUTH_HOME}/operations/configure-${operationId}.request.json`;
	const resultPath = `${AUTH_HOME}/operations/configure-${operationId}.result.json`;
	yield* authority.provider
		.writeTextFile(
			authority.sandboxId,
			requestPath,
			JSON.stringify(request),
			"zuse",
		)
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_setup_failed")));
	yield* authority.provider
		.startProcess(authority.sandboxId, {
			command: "node",
			args: [AUTH_CONFIGURATOR, requestPath, resultPath],
			user: "zuse",
			tag: `zuse-cloud-auth-configure-${operationId}`,
		})
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_setup_failed")));
	const result = yield* waitForFile(authority, resultPath, 350);
	try {
		const parsed = JSON.parse(result) as Record<string, unknown>;
		const state =
			parsed.state === "connected" ||
			parsed.state === "expired" ||
			parsed.state === "missing-tool"
				? parsed.state
				: "error";
		return new CloudAuthProviderStatus({
			providerId: request.providerId,
			state,
			method: request.method,
			...(typeof parsed.verifiedAt === "number"
				? { verifiedAt: parsed.verifiedAt }
				: {}),
			...(typeof parsed.errorCode === "string"
				? { errorCode: parsed.errorCode }
				: {}),
		});
	} catch {
		return yield* Effect.fail(serviceUnavailable("cloud_auth_setup_failed"));
	}
});

export const startCloudAuthLogin = Effect.fn("startCloudAuthLogin")(function* (
	accountId: string,
	providerId: "codex" | "grok",
) {
	const authority = yield* ensureRunning(yield* provisionAuthority(accountId));
	const operationId = crypto.randomUUID();
	yield* authority.provider
		.startProcess(authority.sandboxId, {
			command: "node",
			args: [AUTH_LOGIN, providerId, operationId],
			user: "zuse",
			tag: `zuse-cloud-auth-login-${operationId}`,
		})
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_login_failed")));
	return new CloudAuthLoginOperation({
		operationId,
		providerId,
		state: "authorizing",
	});
});

const requireOperationAuthority = Effect.fn(
	"requireCloudAuthOperationAuthority",
)(function* (accountId: string, operationId: string) {
	if (!/^[0-9a-f-]{36}$/iu.test(operationId))
		return yield* Effect.fail(badRequest("invalid_cloud_auth_operation"));
	const recovered = yield* recoverAuthority(accountId);
	if (recovered === null)
		return yield* Effect.fail(badRequest("cloud_auth_not_configured"));
	return yield* ensureRunning(recovered);
});

export const pollCloudAuthLogin = Effect.fn("pollCloudAuthLogin")(function* (
	accountId: string,
	operationId: string,
) {
	const authority = yield* requireOperationAuthority(accountId, operationId);
	const value = yield* readOptional(
		authority,
		`${AUTH_HOME}/operations/${operationId}.json`,
	);
	if (value === null)
		return new CloudAuthLoginOperation({
			operationId,
			providerId: "codex",
			state: "authorizing",
		});
	return operationFrom(operationId, value);
});

export const cancelCloudAuthLogin = Effect.fn("cancelCloudAuthLogin")(
	function* (accountId: string, operationId: string) {
		const authority = yield* requireOperationAuthority(accountId, operationId);
		const operationPath = `${AUTH_HOME}/operations/${operationId}.json`;
		yield* authority.provider
			.startProcess(authority.sandboxId, {
				command: "node",
				args: [AUTH_CANCEL, operationPath],
				user: "zuse",
				tag: `zuse-cloud-auth-cancel-${operationId}`,
			})
			.pipe(
				Effect.mapError(() => serviceUnavailable("cloud_auth_cancel_failed")),
			);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const value = yield* readOptional(authority, operationPath);
			if (value !== null) {
				const operation = operationFrom(operationId, value);
				if (operation.state === "cancelled") return operation;
			}
			yield* Effect.sleep("100 millis");
		}
		return yield* Effect.fail(serviceUnavailable("cloud_auth_cancel_failed"));
	},
);

export const disconnectCloudAuth = Effect.fn("disconnectCloudAuth")(function* (
	accountId: string,
	providerId: CloudAuthProvider,
) {
	const recovered = yield* recoverAuthority(accountId);
	if (recovered === null)
		return new CloudAuthProviderStatus({ providerId, state: "disconnected" });
	const authority = yield* ensureRunning(recovered);
	const operationId = crypto.randomUUID();
	const resultPath = `${AUTH_HOME}/operations/disconnect-${operationId}.done`;
	const script = `import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const providerId = ${JSON.stringify(providerId)};
const credentialPath = ${JSON.stringify(`${AUTH_HOME}/providers/${providerId}.json`)};
let credential;
try { credential = JSON.parse(await readFile(credentialPath, "utf8")); } catch {}
if (credential?.native === true || providerId === "codex") await new Promise((resolve) => {
  const command = providerId === "cursor" ? "cursor-agent" : providerId;
  const args = providerId === "claude" ? ["auth", "logout"] : ["logout"];
  const child = spawn(command, args, { stdio: "ignore" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
  child.once("error", () => { clearTimeout(timer); resolve(); });
  child.once("exit", () => { clearTimeout(timer); resolve(); });
});
const imageSecretsPath = "/home/zuse/.zuse-image/provider-secrets.json";
try {
  const imageSecrets = JSON.parse(await readFile(imageSecretsPath, "utf8"));
  delete imageSecrets[providerId];
  await writeFile(imageSecretsPath, JSON.stringify(imageSecrets), { mode: 0o600 });
  await chmod(imageSecretsPath, 0o600);
} catch {}
await Promise.all([
  rm(credentialPath, { force: true }),
]);
await writeFile(${JSON.stringify(`${AUTH_HOME}/status/${providerId}.json`)}, JSON.stringify({ providerId, state: "disconnected", verifiedAt: Date.now() }), { mode: 0o600 });
await writeFile(${JSON.stringify(resultPath)}, "ready", { mode: 0o600 });`;
	const path = `${AUTH_HOME}/operations/disconnect-${operationId}.mjs`;
	yield* authority.provider
		.writeTextFile(authority.sandboxId, path, script, "zuse")
		.pipe(
			Effect.mapError(() => serviceUnavailable("cloud_auth_disconnect_failed")),
		);
	yield* authority.provider
		.startProcess(authority.sandboxId, {
			command: "node",
			args: [path],
			user: "zuse",
			tag: `zuse-cloud-auth-disconnect-${operationId}`,
		})
		.pipe(
			Effect.mapError(() => serviceUnavailable("cloud_auth_disconnect_failed")),
		);
	yield* waitForFile(authority, resultPath);
	return new CloudAuthProviderStatus({ providerId, state: "disconnected" });
});

/**
 * Captures the provider-owned state created by official setup as the seed for
 * a clean private account image. The image builder removes authority keys and
 * operation files before promoting the final snapshot.
 */
export const snapshotCloudAuthAuthority = Effect.fn(
	"snapshotCloudAuthAuthority",
)(function* (accountId: string, name: string) {
	const recovered = yield* recoverAuthority(accountId);
	if (recovered === null) return undefined;
	const authority = yield* ensureRunning(recovered);
	yield* readCloudAuthStatus(accountId, true);
	return yield* authority.provider
		.snapshot(authority.sandboxId, name)
		.pipe(
			Effect.mapError(() => serviceUnavailable("cloud_auth_snapshot_failed")),
		);
});

export type CloudAuthAuthorityContext = SandboxProviders | ApiConfiguration;
