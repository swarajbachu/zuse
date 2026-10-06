import { Effect, Redacted, Schema } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { githubRequest } from "./cloud-github-request.ts";
import { ApiConfiguration } from "./config.ts";
import { ApiError, badRequest, serviceUnavailable } from "./errors.ts";

export { githubRequest } from "./cloud-github-request.ts";

const GithubInstallation = Schema.Struct({
	id: Schema.Number,
	account: Schema.Struct({
		id: Schema.Number,
		login: Schema.String,
		type: Schema.Literals(["User", "Organization"]),
		avatar_url: Schema.optionalKey(Schema.String),
	}),
	repository_selection: Schema.Literals(["all", "selected"]),
	suspended_at: Schema.NullOr(Schema.String),
});
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
	0x05, 0x00,
]);

const derLength = (length: number): Uint8Array => {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: Array<number> = [];
	for (let remaining = length; remaining > 0; remaining >>>= 8)
		bytes.unshift(remaining & 0xff);
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

const derValue = (tag: number, value: Uint8Array): Uint8Array =>
	Uint8Array.from([tag, ...derLength(value.length), ...value]);

const pemBody = (pem: string): Uint8Array => {
	const encoded = pem.replace(/-----[^-]+-----|\s/gu, "");
	return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
};

const encodePem = (label: string, der: Uint8Array): string => {
	let binary = "";
	for (const byte of der) binary += String.fromCharCode(byte);
	const encoded =
		btoa(binary)
			.match(/.{1,64}/gu)
			?.join("\n") ?? "";
	return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
};

/** GitHub currently downloads RSA keys as PKCS#1; jose imports PKCS#8. */
export const normalizeGithubPrivateKey = (pem: string): string => {
	if (pem.includes("-----BEGIN PRIVATE KEY-----")) return pem;
	if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----"))
		throw new Error("unsupported_github_private_key");
	const privateKey = derValue(0x04, pemBody(pem));
	const body = Uint8Array.from([
		0x02,
		0x01,
		0x00,
		...RSA_ALGORITHM_IDENTIFIER,
		...privateKey,
	]);
	return encodePem("PRIVATE KEY", derValue(0x30, body));
};

const appJwt = Effect.fn("githubAppJwt")(function* (forceAppId = false) {
	const config = yield* ApiConfiguration;
	const github = config.githubApp;
	if (github === undefined)
		return yield* Effect.fail(serviceUnavailable("github_app_not_configured"));
	const now = Math.floor(Date.now() / 1_000);
	const key = yield* Effect.tryPromise({
		try: () =>
			importPKCS8(
				normalizeGithubPrivateKey(Redacted.value(github.privateKey)),
				"RS256",
			),
		catch: () => serviceUnavailable("github_app_key_invalid"),
	});
	return yield* Effect.promise(() =>
		new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			// GitHub accepts either identifier, but recommends the client ID for
			// the JWT issuer. Keep App ID as a compatibility fallback.
			.setIssuer(forceAppId ? github.appId : (github.clientId ?? github.appId))
			.setIssuedAt(now - 60)
			.setExpirationTime(now + 9 * 60)
			.sign(key),
	);
});

export const githubAppRequest = <A>(url: string, init?: RequestInit) =>
	Effect.gen(function* () {
		const github = (yield* ApiConfiguration).githubApp;
		const primaryJwt = yield* appJwt();
		const primary = githubRequest<A>(url, primaryJwt, init);
		if (github?.clientId === undefined) return yield* primary;
		return yield* primary.pipe(
			Effect.catch((error) =>
				error.detail !== "github_401"
					? Effect.fail(error)
					: Effect.gen(function* () {
							const fallbackJwt = yield* appJwt(true);
							return yield* githubRequest<A>(url, fallbackJwt, init);
						}),
			),
		);
	});

export const readGithubInstallation = Effect.fn("readGithubInstallation")(
	function* (installationId: number) {
		const installation = yield* githubAppRequest<unknown>(
			`https://api.github.com/app/installations/${installationId}`,
			{ signal: AbortSignal.timeout(5_000) },
		).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(GithubInstallation)),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("invalid_github_installation"),
			),
		);
		if (installation.id !== installationId)
			return yield* badRequest("github_installation_mismatch");
		return installation;
	},
);

export const exchangeGithubCode = Effect.fn("exchangeGithubCode")(function* (
	code: string,
	callback: string,
) {
	const github = (yield* ApiConfiguration).githubApp;
	if (!github?.clientId || !github.clientSecret)
		return yield* serviceUnavailable("github_app_oauth_not_configured");
	const clientSecret = Redacted.value(github.clientSecret);
	return yield* Effect.tryPromise({
		try: async () => {
			const response = await fetch(
				"https://github.com/login/oauth/access_token",
				{
					method: "POST",
					signal: AbortSignal.timeout(10_000),
					headers: {
						accept: "application/json",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						client_id: github.clientId,
						client_secret: clientSecret,
						code,
						redirect_uri: callback,
					}),
				},
			);
			if (!response.ok) throw new Error("github_oauth_failed");
			return Schema.decodeUnknownSync(
				Schema.Struct({ access_token: Schema.String }),
			)(await response.json());
		},
		catch: () => badRequest("github_authorization_failed"),
	});
});
