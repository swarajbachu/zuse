import {
	type CloudAuthConfigureRequest,
	CloudAuthLoginOperation,
	type CloudAuthProvider,
	CloudAuthProviderStatus,
	CloudAuthStatus,
	CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
	type CodexGrantRefreshReason,
	SealedCodexGrant,
} from "@zuse/contracts";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Effect, Schedule } from "effect";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { badRequest, serviceUnavailable } from "./errors.ts";

const AUTH_HOME = "/home/zuse/.zuse/cloud-auth";
const AUTH_PUBLIC_JWK = `${AUTH_HOME}/public.jwk.json`;
const AUTH_KEY_ID = `${AUTH_HOME}/key-id`;
const AUTH_STORAGE_INCARNATION_ID = `${AUTH_HOME}/storage-incarnation-id`;
const AUTH_CODEX_TOOLCHAIN_VERSION = `${AUTH_HOME}/codex-toolchain-version`;
const AUTH_BOOTSTRAP_HOME = `${AUTH_HOME}/bootstrap`;
const AUTH_INITIALIZER = `${AUTH_BOOTSTRAP_HOME}/initialize.mjs`;
const AUTH_CONFIGURATOR = `${AUTH_BOOTSTRAP_HOME}/configure.mjs`;
const AUTH_LOGIN = `${AUTH_BOOTSTRAP_HOME}/login.mjs`;
const AUTH_CANCEL = `${AUTH_BOOTSTRAP_HOME}/cancel.mjs`;
const AUTH_VERIFY = `${AUTH_BOOTSTRAP_HOME}/verify.mjs`;
const AUTH_CODEX_GRANT = `${AUTH_BOOTSTRAP_HOME}/codex-grant.mjs`;
const AUTH_TIMEOUT_SECONDS = 60 * 60;
const AUTH_PROVISIONING_LEASE_MS = 2 * 60 * 1000;
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

const INITIALIZER_SOURCE = `import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
const home = "/home/zuse/.zuse/cloud-auth";
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(home + "/operations", { recursive: true, mode: 0o700 });
mkdirSync(home + "/grant-cache", { recursive: true, mode: 0o700 });
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
if (!existsSync(home + "/storage-incarnation-id")) writeFileSync(home + "/storage-incarnation-id", randomUUID(), { mode: 0o600 });
if (!existsSync(home + "/grant-fingerprint.key")) writeFileSync(home + "/grant-fingerprint.key", randomBytes(32).toString("base64url"), { mode: 0o600 });
const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
writeFileSync(home + "/codex-toolchain-version", codexVersion.status === 0 ? codexVersion.stdout.trim() : "unavailable", { mode: 0o600 });
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
import readline from "node:readline";
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
  const runStatus = () => new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: 127, error: error.code === "ENOENT" ? "missing-tool" : "verification-failed" }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 1 }); });
  });
  const readManagedCodexAccount = () => new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let phase = "initialize";
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill("SIGTERM"); resolve(result); };
    const timer = setTimeout(() => finish({ code: 1, error: "verification-timeout" }), 30000);
    child.once("error", (error) => finish({ code: 127, error: error.code === "ENOENT" ? "missing-tool" : "verification-failed" }));
    child.once("exit", (code) => { if (!settled && code !== 0) finish({ code: code ?? 1, error: "verification-failed" }); });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (phase === "initialize" && message.id === 1) {
        if (message.error !== undefined) return finish({ code: 1, error: "verification-failed" });
        phase = "account";
        child.stdin.write(JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: false } }) + "\\n");
      } else if (phase === "account" && message.id === 2) {
        finish(message.error === undefined && message.result?.account?.type === "chatgpt" ? { code: 0 } : { code: 1, error: "managed-auth-unavailable" });
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "zuse-cloud-auth", version: "1" }, capabilities: { experimentalApi: true } } }) + "\\n");
  });
  const result = providerId === "codex" && credential.native === true ? await readManagedCodexAccount() : await runStatus();
  const state = result.code === 0 ? "connected" : result.error === "missing-tool" ? "missing-tool" : "expired";
  await writeFile(home + "/status/" + providerId + ".json", JSON.stringify({ providerId, method: credential.method, native: credential.native === true, state, verifiedAt: result.code === 0 ? credential.updatedAt ?? Date.now() : undefined, errorCode: result.code === 0 ? undefined : result.error ?? "verification-failed" }), { mode: 0o600 });
};
await mkdir(home + "/status", { recursive: true, mode: 0o700 });
await Promise.all(providers.map(verify));
await writeFile(markerPath, "ready", { mode: 0o600 });
`;

export const CODEX_GRANT_SOURCE = String.raw`import { createCipheriv, createHmac, createPublicKey, constants, publicEncrypt, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import readline from "node:readline";
const home = process.env.ZUSE_CLOUD_AUTH_HOME ?? "/home/zuse/.zuse/cloud-auth";
const codexAuthFile = process.env.ZUSE_CODEX_AUTH_FILE ?? "/home/zuse/.codex/auth.json";
const requestPath = process.argv[2];
const resultPath = process.argv[3];
const cachePath = process.argv[4];
const input = JSON.parse(await readFile(requestPath, "utf8"));
const writeResult = (value) => writeFile(resultPath, JSON.stringify(value), { mode: 0o600 });
const requiredStrings = ["requestId", "accountId", "workspaceId", "credentialPublicJwk", "keyThumbprint", "authorityIncarnationId"];
if (input.protocolVersion !== 1 || !Number.isSafeInteger(input.runtimeGeneration) || requiredStrings.some((key) => typeof input[key] !== "string" || input[key].length === 0)) {
  await writeResult({ errorCode: "codex-auth-update-required" });
  process.exit(0);
}
const incarnation = (await readFile(home + "/storage-incarnation-id", "utf8")).trim();
if (incarnation !== input.authorityIncarnationId) {
  await writeResult({ errorCode: "codex-auth-reconnect-required" });
  process.exit(0);
}
const fingerprintKey = Buffer.from((await readFile(home + "/grant-fingerprint.key", "utf8")).trim(), "base64url");
const fingerprintPayload = JSON.stringify({ protocolVersion: input.protocolVersion, requestId: input.requestId, accountId: input.accountId, workspaceId: input.workspaceId, runtimeGeneration: input.runtimeGeneration, credentialPublicJwk: input.credentialPublicJwk, keyThumbprint: input.keyThumbprint, reason: input.reason, previousChatgptAccountId: input.previousChatgptAccountId ?? null, authorityIncarnationId: input.authorityIncarnationId, authorityEpoch: input.authorityEpoch });
const fingerprint = createHmac("sha256", fingerprintKey).update(fingerprintPayload).digest("base64url");
try {
  const cached = JSON.parse(await readFile(cachePath, "utf8"));
  if (cached.fingerprint !== fingerprint) await writeResult({ errorCode: "codex_grant_request_id_reused" });
  else await writeResult(cached);
  process.exit(0);
} catch {}
const record = (value) => typeof value === "object" && value !== null ? value : {};
const string = (value) => typeof value === "string" && value.length > 0 ? value : null;
const decodeJwt = (token) => {
  try { return record(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))); } catch { return {}; }
};
const readManagedAuth = async () => {
  const root = record(JSON.parse(await readFile(codexAuthFile, "utf8")));
  const tokens = record(root.tokens);
  const accessToken = string(tokens.access_token) ?? string(tokens.accessToken);
  const refreshToken = string(tokens.refresh_token) ?? string(tokens.refreshToken);
  if (accessToken === null || refreshToken === null) throw new Error("managed_auth_unavailable");
  const accessClaims = decodeJwt(accessToken);
  const idClaims = string(tokens.id_token) === null ? {} : decodeJwt(tokens.id_token);
  const accessAuth = record(accessClaims["https://api.openai.com/auth"]);
  const idAuth = record(idClaims["https://api.openai.com/auth"]);
  const chatgptAccountId = string(tokens.account_id) ?? string(tokens.accountId) ?? string(accessAuth.chatgpt_account_id) ?? string(idAuth.chatgpt_account_id);
  if (chatgptAccountId === null) throw new Error("managed_account_unavailable");
  const chatgptPlanType = string(accessAuth.chatgpt_plan_type) ?? string(idAuth.chatgpt_plan_type);
  const expiresAt = typeof accessClaims.exp === "number" ? accessClaims.exp * 1000 : 0;
  return { accessToken, chatgptAccountId, chatgptPlanType, expiresAt };
};
const refreshManagedAuth = () => new Promise((resolve, reject) => {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let phase = "initialize";
  let settled = false;
  let timer;
  const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill("SIGTERM"); error === null ? resolve() : reject(error); };
  timer = setTimeout(() => finish(new Error("refresh_timeout")), 8000);
  child.once("error", finish);
  child.once("exit", (code) => { if (code !== 0) finish(new Error("refresh_failed")); });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (phase === "initialize" && message.id === 1) {
      if (message.error !== undefined) return finish(new Error("refresh_initialize_failed"));
      phase = "account";
      child.stdin.write(JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: true } }) + "\n");
      return;
    }
    if (phase === "account" && message.id === 2) {
      if (message.error !== undefined || message.result?.account?.type !== "chatgpt") return finish(new Error("managed_auth_unavailable"));
      finish(null);
    }
  });
  child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "zuse-cloud-auth", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
});
let auth;
try {
  auth = await readManagedAuth();
  if (input.reason === "unauthorized" || auth.expiresAt <= Date.now() + 5 * 60 * 1000) {
    await refreshManagedAuth();
    auth = await readManagedAuth();
  }
} catch {
  await writeResult({ errorCode: "codex-auth-reconnect-required" });
  process.exit(0);
}
if (auth.expiresAt <= Date.now() + 60 * 1000 || (input.previousChatgptAccountId && input.previousChatgptAccountId !== auth.chatgptAccountId)) {
  await writeResult({ errorCode: "codex-auth-reconnect-required" });
  process.exit(0);
}
const publicJwk = JSON.parse(input.credentialPublicJwk);
const key = createPublicKey({ key: publicJwk, format: "jwk" });
const issuedAt = Date.now();
const expiresAt = auth.expiresAt;
const aadObject = { protocolVersion: 1, requestId: input.requestId, keyThumbprint: input.keyThumbprint, authorityIncarnationId: incarnation, authorityEpoch: input.authorityEpoch };
const aad = Buffer.from(JSON.stringify(aadObject));
const plaintext = Buffer.from(JSON.stringify({ zuseAccountId: input.accountId, workspaceId: input.workspaceId, runtimeGeneration: input.runtimeGeneration, keyThumbprint: input.keyThumbprint, authorityIncarnationId: incarnation, authorityEpoch: input.authorityEpoch, chatgptAccountId: auth.chatgptAccountId, chatgptPlanType: auth.chatgptPlanType, issuedAt, expiresAt, accessToken: auth.accessToken }));
const contentKey = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const sealed = { ...aadObject, wrappedKey: publicEncrypt({ key, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, contentKey).toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
const output = { fingerprint, sealed };
await writeFile(cachePath, JSON.stringify(output), { mode: 0o600, flag: "wx" }).catch(async (error) => { if (error.code !== "EEXIST") throw error; });
const committed = JSON.parse(await readFile(cachePath, "utf8"));
if (committed.fingerprint !== fingerprint) await writeResult({ errorCode: "codex_grant_request_id_reused" });
else await writeResult(committed);
`;

type Authority = {
	readonly provider: SandboxProviderAdapter;
	readonly sandboxId: string;
	readonly state: "running" | "paused";
	readonly storageIncarnationId: string;
	readonly authEpoch: number;
};

export const cloudAuthAuthorityLabel = (input: {
	readonly accountId: string;
	readonly apiIssuer: string;
}) =>
	sha256Hex(
		`cloud-auth-authority-v3:${input.apiIssuer}:${input.accountId}`,
	).pipe(Effect.map((digest) => `zuse-auth-${digest.slice(0, 32)}`));

/** Previous label retained only for one-time authority adoption. */
export const legacyCloudAuthAuthorityLabel = (input: {
	readonly accountId: string;
	readonly apiIssuer: string;
	readonly templateVersion: string;
}) =>
	sha256Hex(
		`cloud-auth-authority-v2:${input.apiIssuer}:${input.templateVersion}:${input.accountId}`,
	).pipe(Effect.map((digest) => `zuse-auth-${digest.slice(0, 32)}`));

const authorityLabel = (accountId: string) =>
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		return yield* cloudAuthAuthorityLabel({
			accountId,
			apiIssuer: config.apiIssuer,
		});
	});

const legacyAuthorityLabel = (
	accountId: string,
	provider: SandboxProviderAdapter,
) =>
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		return yield* legacyCloudAuthAuthorityLabel({
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
	const store = yield* CloudWorkspaceStore;
	const locator = yield* store.getCloudAuthAuthority(accountId);
	if (locator?.providerSandboxId !== undefined) {
		const sandbox = yield* provider
			.inspect(locator.providerSandboxId)
			.pipe(
				Effect.mapError(() => serviceUnavailable("cloud_auth_unavailable")),
			);
		if (sandbox !== null)
			return {
				provider,
				sandboxId: sandbox.providerSandboxId,
				state: sandbox.state,
				storageIncarnationId: locator.storageIncarnationId,
				authEpoch: locator.authEpoch,
			} satisfies Authority;
		// A persisted locator is authoritative. Never guess after its storage is
		// lost; the account must explicitly reconnect Codex.
		return null;
	}
	const stable = yield* provider
		.recoverByLabel(yield* authorityLabel(accountId))
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_unavailable")));
	const legacy =
		stable === null
			? yield* provider
					.recoverByLabel(yield* legacyAuthorityLabel(accountId, provider))
					.pipe(
						Effect.mapError(() => serviceUnavailable("cloud_auth_unavailable")),
					)
			: null;
	const sandbox = stable ?? legacy;
	if (sandbox === null) return null;
	const initialized = yield* initializeAuthority({
		provider,
		sandboxId: sandbox.providerSandboxId,
		state: sandbox.state,
		storageIncarnationId: crypto.randomUUID(),
		authEpoch: 1,
	});
	const leaseOwner = crypto.randomUUID();
	const nowMs = Date.now();
	const claim = yield* store.claimCloudAuthAuthority({
		accountId,
		provider: provider.providerId,
		candidateStorageIncarnationId: initialized.storageIncarnationId,
		toolchainVersion: CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
		leaseOwner,
		nowMs,
		leaseExpiresAtMs: nowMs + AUTH_PROVISIONING_LEASE_MS,
	});
	const record = claim.acquired
		? yield* store.completeCloudAuthAuthorityProvisioning({
				accountId,
				providerSandboxId: sandbox.providerSandboxId,
				storageIncarnationId: initialized.storageIncarnationId,
				toolchainVersion: CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
				leaseOwner,
				nowMs: Date.now(),
			})
		: claim.record;
	if (record?.providerSandboxId !== sandbox.providerSandboxId) return null;
	return {
		provider,
		sandboxId: initialized.sandboxId,
		state: initialized.state,
		storageIncarnationId: record.storageIncarnationId,
		authEpoch: record.authEpoch,
	} satisfies Authority;
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
				[AUTH_CODEX_GRANT, CODEX_GRANT_SOURCE],
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
		const storageIncarnationId = yield* waitForFile(
			authority,
			AUTH_STORAGE_INCARNATION_ID,
		);
		const codexToolchainVersion = yield* waitForFile(
			authority,
			AUTH_CODEX_TOOLCHAIN_VERSION,
		);
		if (
			!codexToolchainVersion
				.split(/\s+/u)
				.includes(CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION)
		)
			return yield* Effect.fail(
				serviceUnavailable("codex-auth-update-required"),
			);
		return { ...authority, storageIncarnationId } satisfies Authority;
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
	allowLostReplacement = false,
) {
	const recovered = yield* recoverAuthority(accountId);
	if (recovered !== null) {
		const initialized = yield* initializeAuthority(
			yield* ensureRunning(recovered),
		);
		if (initialized.storageIncarnationId === recovered.storageIncarnationId)
			return initialized;
		if (!allowLostReplacement)
			return yield* Effect.fail(
				serviceUnavailable("codex-auth-reconnect-required"),
			);
	}
	const provider = yield* e2bProvider;
	const store = yield* CloudWorkspaceStore;
	const locator = yield* store.getCloudAuthAuthority(accountId);
	const replacingLostAuthority = locator?.state === "ready";
	if (replacingLostAuthority && !allowLostReplacement)
		return yield* Effect.fail(
			serviceUnavailable("codex-auth-reconnect-required"),
		);
	const leaseOwner = crypto.randomUUID();
	const nowMs = Date.now();
	const claim = yield* store.claimCloudAuthAuthority({
		accountId,
		provider: provider.providerId,
		candidateStorageIncarnationId: crypto.randomUUID(),
		toolchainVersion: CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
		leaseOwner,
		nowMs,
		leaseExpiresAtMs: nowMs + AUTH_PROVISIONING_LEASE_MS,
		replaceReady: replacingLostAuthority,
	});
	if (!claim.acquired) {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			yield* Effect.sleep("250 millis");
			const winner = yield* recoverAuthority(accountId);
			if (winner !== null)
				return yield* initializeAuthority(yield* ensureRunning(winner));
		}
		return yield* Effect.fail(
			serviceUnavailable("cloud_auth_reconnect_required"),
		);
	}
	const label = yield* authorityLabel(accountId);
	const concurrent = yield* provider
		.recoverByLabel(label)
		.pipe(Effect.mapError(() => serviceUnavailable("cloud_auth_unavailable")));
	const sandboxId = `auth_${(yield* sha256Hex(`${accountId}:${crypto.randomUUID()}`)).slice(0, 24)}`;
	const created =
		concurrent ??
		(yield* provider
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
				Effect.mapError(() =>
					serviceUnavailable("cloud_auth_provision_failed"),
				),
			));
	const initialized = yield* initializeAuthority({
		provider,
		sandboxId: created.providerSandboxId,
		state: created.state,
		storageIncarnationId: claim.record.storageIncarnationId,
		authEpoch: claim.record.authEpoch,
	});
	const record = yield* store.completeCloudAuthAuthorityProvisioning({
		accountId,
		providerSandboxId: created.providerSandboxId,
		storageIncarnationId: initialized.storageIncarnationId,
		toolchainVersion: CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
		leaseOwner,
		nowMs: Date.now(),
	});
	if (record === null)
		return yield* Effect.fail(
			serviceUnavailable("cloud_auth_provision_conflict"),
		);
	return {
		...initialized,
		storageIncarnationId: record.storageIncarnationId,
		authEpoch: record.authEpoch,
	} satisfies Authority;
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
	if (authority.storageIncarnationId !== recovered.storageIncarnationId)
		return new CloudAuthStatus({
			authorityState: "error",
			providers: PROVIDERS.map(
				(providerId) =>
					new CloudAuthProviderStatus({
						providerId,
						state: "error",
						errorCode: "codex-auth-reconnect-required",
					}),
			),
			updatedAt: Date.now(),
		});
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
	// This RPC is an explicit account action, so it may replace a persisted
	// authority locator only after the provider proves its storage is gone.
	yield* provisionAuthority(accountId, true);
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
	if (providerId === "codex") {
		yield* (yield* CloudWorkspaceStore).advanceCloudAuthEpoch({
			accountId,
			providerSandboxId: authority.sandboxId,
			nowMs: Date.now(),
		});
	}
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

export interface IssueCodexGrantInput {
	readonly accountId: string;
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly recipientPublicJwk: string;
	readonly recipientKeyThumbprint: string;
	readonly requestId: string;
	readonly reason: CodexGrantRefreshReason;
	readonly previousChatgptAccountId?: string;
}

/**
 * The single account-level Codex token operation. The authority refreshes its
 * native managed login under a process lock and seals an access-only grant
 * directly to the enrolled runtime key. No plaintext token crosses this API.
 */
export const issueCodexGrant = Effect.fn("issueCodexGrant")(function* (
	input: IssueCodexGrantInput,
) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
			input.requestId,
		) ||
		input.recipientPublicJwk.length > 16_384 ||
		(input.previousChatgptAccountId?.length ?? 0) > 256
	)
		return yield* Effect.fail(badRequest("invalid_codex_grant_request"));
	const authority = yield* ensureRunning(
		yield* provisionAuthority(input.accountId),
	);
	const operationId = crypto.randomUUID();
	const requestPath = `${AUTH_HOME}/operations/codex-grant-${operationId}.request.json`;
	const resultPath = `${AUTH_HOME}/operations/codex-grant-${operationId}.result.json`;
	const cachePath = `${AUTH_HOME}/grant-cache/${input.requestId}.json`;
	yield* authority.provider
		.writeTextFile(
			authority.sandboxId,
			requestPath,
			JSON.stringify({
				protocolVersion: 1,
				requestId: input.requestId,
				accountId: input.accountId,
				workspaceId: input.workspaceId,
				runtimeGeneration: input.runtimeGeneration,
				credentialPublicJwk: input.recipientPublicJwk,
				keyThumbprint: input.recipientKeyThumbprint,
				reason: input.reason,
				...(input.previousChatgptAccountId === undefined
					? {}
					: { previousChatgptAccountId: input.previousChatgptAccountId }),
				authorityIncarnationId: authority.storageIncarnationId,
				authorityEpoch: authority.authEpoch,
			}),
			"zuse",
		)
		.pipe(Effect.mapError(() => serviceUnavailable("codex-auth-reconnecting")));
	yield* authority.provider
		.startProcess(authority.sandboxId, {
			command: "flock",
			args: [
				"-x",
				`${AUTH_HOME}/codex-refresh.lock`,
				"node",
				AUTH_CODEX_GRANT,
				requestPath,
				resultPath,
				cachePath,
			],
			user: "zuse",
			tag: `zuse-cloud-auth-codex-grant-${operationId}`,
		})
		.pipe(Effect.mapError(() => serviceUnavailable("codex-auth-reconnecting")));
	const value = yield* waitForFile(authority, resultPath, 350);
	let parsed: { readonly errorCode?: unknown; readonly sealed?: unknown };
	try {
		parsed = JSON.parse(value) as typeof parsed;
	} catch {
		return yield* Effect.fail(serviceUnavailable("codex_grant_invalid"));
	}
	if (typeof parsed.errorCode === "string")
		return yield* Effect.fail(serviceUnavailable(parsed.errorCode));
	const sealed = parsed.sealed as Record<string, unknown>;
	const sealedString = (key: string, maxLength: number): string | null => {
		const value = sealed?.[key];
		return typeof value === "string" &&
			value.length > 0 &&
			value.length <= maxLength
			? value
			: null;
	};
	const wrappedKey = sealedString("wrappedKey", 8_192);
	const iv = sealedString("iv", 128);
	const ciphertext = sealedString("ciphertext", 32_768);
	const tag = sealedString("tag", 128);
	if (
		sealed?.protocolVersion !== 1 ||
		sealed.requestId !== input.requestId ||
		sealed.keyThumbprint !== input.recipientKeyThumbprint ||
		sealed.authorityIncarnationId !== authority.storageIncarnationId ||
		sealed.authorityEpoch !== authority.authEpoch ||
		wrappedKey === null ||
		iv === null ||
		ciphertext === null ||
		tag === null
	)
		return yield* Effect.fail(serviceUnavailable("codex_grant_fence_mismatch"));
	return new SealedCodexGrant({
		protocolVersion: 1,
		requestId: input.requestId,
		keyThumbprint: input.recipientKeyThumbprint,
		authorityIncarnationId: authority.storageIncarnationId,
		authorityEpoch: authority.authEpoch,
		wrappedKey,
		iv,
		ciphertext,
		tag,
	});
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

export type CloudAuthAuthorityContext =
	| SandboxProviders
	| ApiConfiguration
	| CloudWorkspaceStore;
