import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import {
	AttachmentRef,
	LinearConnection,
	LinearContextFile,
	LinearContextWarning,
	LinearIntegrationError,
	type LinearIssueRef,
	LinearIssueSummary,
	type SessionId,
} from "@zuse/contracts";
import { Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthShell } from "../../auth/services/auth-shell.ts";
import { resolveSessionCwd } from "../../context/context-files.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import {
	LinearApiError,
	type LinearFetch,
	type LinearIssueDocument,
	linearGraphql,
	makeLinearIssueListRequest,
	renderLinearIssueMarkdown,
	rewriteMarkdownImages,
} from "../linear-api.ts";
import type { LinearToolIssueUpdate } from "../services/linear-service.ts";
import { LinearService } from "../services/linear-service.ts";

const CLIENT_ID = (process.env.LINEAR_CLIENT_ID ?? "").trim();
const INTEGRATION = "linear";
const REFRESH_SKEW_MS = 60_000;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

const TokenBundleSchema = Schema.Struct({
	accessToken: Schema.String,
	refreshToken: Schema.String,
	expiresAt: Schema.Number,
	workspaceId: Schema.String,
	workspaceName: Schema.String,
	workspaceKey: Schema.String,
	viewerId: Schema.String,
	viewerName: Schema.String,
	viewerEmail: Schema.String,
	connectedAt: Schema.String,
});
type TokenBundle = typeof TokenBundleSchema.Type;

interface NamedNode {
	readonly id: string;
	readonly name: string;
	readonly email?: string;
}

interface CommentNode {
	readonly body?: string | null;
	readonly createdAt?: string | null;
	readonly user?: { readonly name?: string | null } | null;
}

interface CommentConnection {
	readonly nodes?: ReadonlyArray<CommentNode>;
	readonly pageInfo?: {
		readonly hasNextPage: boolean;
		readonly endCursor: string | null;
	};
}

interface IssueSummaryPayload {
	readonly id: string;
	readonly identifier: string;
	readonly title: string;
	readonly priority?: number | null;
	readonly updatedAt: string;
	readonly state?: {
		readonly name?: string | null;
		readonly type?: string | null;
		readonly color?: string | null;
	} | null;
	readonly assignee?: {
		readonly name?: string | null;
		readonly avatarUrl?: string | null;
	} | null;
	readonly labels?: {
		readonly nodes?: ReadonlyArray<{ readonly name: string }>;
	};
}

interface IssueDocumentPayload {
	readonly identifier: string;
	readonly title: string;
	readonly url: string;
	readonly description?: string | null;
	readonly priorityLabel?: string | null;
	readonly state?: { readonly name?: string | null } | null;
	readonly assignee?: { readonly name?: string | null } | null;
	readonly labels?: {
		readonly nodes?: ReadonlyArray<{ readonly name: string }>;
	};
	readonly project?: { readonly name?: string | null } | null;
	readonly cycle?: { readonly name?: string | null } | null;
	readonly relations?: {
		readonly nodes?: ReadonlyArray<{
			readonly type?: string | null;
			readonly relatedIssue?: {
				readonly identifier?: string | null;
				readonly title?: string | null;
			} | null;
		}>;
	};
	readonly comments?: CommentConnection;
}

interface IssueLookupPayload {
	readonly id: string;
	readonly identifier: string;
	readonly title: string;
	readonly url: string;
	readonly project?: NamedNode | null;
	readonly team?: {
		readonly states?: { readonly nodes?: ReadonlyArray<NamedNode> };
		readonly labels?: { readonly nodes?: ReadonlyArray<NamedNode> };
		readonly members?: { readonly nodes?: ReadonlyArray<NamedNode> };
		readonly projects?: { readonly nodes?: ReadonlyArray<NamedNode> };
	};
}

const TokenResponseSchema = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.String,
	expires_in: Schema.Number,
});

const fail = (reason: string): LinearIntegrationError =>
	new LinearIntegrationError({ reason });

const errorMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const parseBundle = (raw: string | null): TokenBundle | null => {
	if (raw === null) return null;
	try {
		return Schema.decodeUnknownSync(TokenBundleSchema)(JSON.parse(raw));
	} catch {
		return null;
	}
};

const toConnection = (bundle: TokenBundle): LinearConnection =>
	LinearConnection.make({
		workspaceId: bundle.workspaceId,
		workspaceName: bundle.workspaceName,
		workspaceKey: bundle.workspaceKey,
		viewerName: bundle.viewerName,
		viewerEmail: bundle.viewerEmail,
		connectedAt: new Date(bundle.connectedAt),
	});

const base64url = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64url");

const makePkce = () => {
	const verifier = base64url(randomBytes(32));
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
		state: base64url(randomBytes(16)),
	};
};

const authorizeUrl = (
	challenge: string,
	state: string,
	redirectUri: string,
): string => {
	const url = new URL("https://linear.app/oauth/authorize");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "read,write");
	url.searchParams.set("actor", "user");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	return url.toString();
};

interface PendingConnect {
	readonly state: string;
	readonly verifier: string;
	readonly resolve: (url: string) => void;
	readonly reject: (cause: Error) => void;
}

const exchangeToken = async (
	fetcher: LinearFetch,
	params: Readonly<Record<string, string>>,
): Promise<typeof TokenResponseSchema.Type> => {
	const response = await fetcher("https://api.linear.app/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	const value: unknown = await response.json().catch(() => null);
	if (!response.ok)
		throw new Error(`Linear OAuth failed (${response.status}).`);
	return Schema.decodeUnknownSync(TokenResponseSchema)(value);
};

const VIEWER_QUERY = `query ZuseLinearViewer {
  viewer { id name email organization { id name urlKey } }
}`;

const ISSUE_QUERY = `query ZuseLinearIssue($id: String!) {
  issue(id: $id) {
    id identifier title url description priorityLabel
    state { name } assignee { name } labels { nodes { name } }
    project { name } cycle { name }
    relations { nodes { type relatedIssue { identifier title } } }
    comments(first: 100) { nodes { body createdAt user { name } } pageInfo { hasNextPage endCursor } }
  }
}`;

const COMMENTS_QUERY = `query ZuseLinearComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { body createdAt user { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ISSUE_LOOKUP_QUERY = `query ZuseLinearIssueLookup($id: String!) {
  issue(id: $id) {
    id identifier title url description priority
    state { id name } assignee { id name } labels { nodes { id name } }
    project { id name } team { id states { nodes { id name } } labels { nodes { id name } } members { nodes { id name email } } projects(first: 250) { nodes { id name } } }
  }
}`;

const COMMENT_MUTATION = `mutation ZuseLinearComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body } }
}`;

const UPDATE_MUTATION = `mutation ZuseLinearUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier title url } }
}`;

const safeSegment = (value: string): string =>
	value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 80) || "workspace";

const isPrivateIp = (address: string): boolean => {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return (
			a === 10 ||
			a === 127 ||
			a === 0 ||
			(a === 169 && b === 254) ||
			(a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) ||
			(a === 192 && b === 168)
		);
	}
	const lower = address.toLowerCase();
	return (
		lower === "::1" ||
		lower.startsWith("fe80:") ||
		lower.startsWith("fc") ||
		lower.startsWith("fd")
	);
};

const validatePublicImageUrl = async (url: URL): Promise<void> => {
	if (url.protocol !== "https:")
		throw new Error("Only HTTPS images are allowed.");
	if (url.hostname === "uploads.linear.app") return;
	const addresses = await lookup(url.hostname, { all: true });
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => isPrivateIp(address))
	) {
		throw new Error("Private image hosts are not allowed.");
	}
};

const IMAGE_TYPES = [
	{ mime: "image/png", acceptedMimes: ["image/png"], extensions: ["png"] },
	{
		mime: "image/jpeg",
		acceptedMimes: ["image/jpeg", "image/jpg"],
		extensions: ["jpg", "jpeg"],
	},
	{ mime: "image/gif", acceptedMimes: ["image/gif"], extensions: ["gif"] },
	{
		mime: "image/webp",
		acceptedMimes: ["image/webp"],
		extensions: ["webp"],
	},
	{
		mime: "image/avif",
		acceptedMimes: ["image/avif"],
		extensions: ["avif"],
	},
	{
		mime: "image/svg+xml",
		acceptedMimes: ["image/svg+xml"],
		extensions: ["svg"],
	},
] as const;

const imageExtension = (mime: string): string | null => {
	const base = mime.split(";")[0]?.trim().toLowerCase();
	return (
		IMAGE_TYPES.find((type) =>
			type.acceptedMimes.some((candidate) => candidate === base),
		)?.extensions[0] ?? null
	);
};

const imageMimeFromPath = (path: string): string | null => {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return (
		IMAGE_TYPES.find((type) =>
			type.extensions.some((candidate) => candidate === ext),
		)?.mime ?? null
	);
};

export const LinearServiceLive = Layer.effect(
	LinearService,
	Effect.gen(function* () {
		const credentials = yield* CredentialsService;
		const shell = yield* AuthShell;
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;
		const sql = yield* SqlClient.SqlClient;
		const attachmentService = yield* AttachmentService;
		const refreshLocks = new Map<string, Semaphore.Semaphore>();
		let pending: PendingConnect | null = null;
		const fetcher: LinearFetch = globalThis.fetch.bind(globalThis);

		const readBundle = Effect.fn("LinearService.readBundle")(function* (
			workspaceId: string,
		) {
			const raw = yield* credentials
				.getIntegration(INTEGRATION, workspaceId)
				.pipe(Effect.mapError((cause) => fail(cause.reason)));
			const bundle = parseBundle(raw);
			if (bundle === null)
				return yield* Effect.fail(fail("Linear workspace is not connected."));
			return bundle;
		});

		const persistBundle = Effect.fn("LinearService.persistBundle")(function* (
			bundle: TokenBundle,
		) {
			yield* credentials
				.setIntegration(INTEGRATION, bundle.workspaceId, JSON.stringify(bundle))
				.pipe(Effect.mapError((cause) => fail(cause.reason)));
			return bundle;
		});

		const freshBundle = Effect.fn("LinearService.freshBundle")(function* (
			workspaceId: string,
		) {
			const seed = yield* readBundle(workspaceId);
			if (seed.expiresAt - Date.now() > REFRESH_SKEW_MS) return seed;
			let lock = refreshLocks.get(workspaceId);
			if (lock === undefined) {
				lock = yield* Semaphore.make(1);
				refreshLocks.set(workspaceId, lock);
			}
			return yield* lock.withPermits(1)(
				Effect.gen(function* () {
					const current = yield* readBundle(workspaceId);
					if (current.expiresAt - Date.now() > REFRESH_SKEW_MS) return current;
					const token = yield* Effect.tryPromise({
						try: () =>
							exchangeToken(fetcher, {
								grant_type: "refresh_token",
								refresh_token: current.refreshToken,
								client_id: CLIENT_ID,
							}),
						catch: (cause) => fail(errorMessage(cause)),
					});
					return yield* persistBundle({
						...current,
						accessToken: token.access_token,
						refreshToken: token.refresh_token,
						expiresAt: Date.now() + token.expires_in * 1_000,
					});
				}),
			);
		});

		const graphql = <A>(
			workspaceId: string,
			query: string,
			variables: Readonly<Record<string, unknown>>,
		) =>
			Effect.gen(function* () {
				let bundle = yield* freshBundle(workspaceId);
				const first = yield* Effect.tryPromise({
					try: () =>
						linearGraphql<A>(fetcher, bundle.accessToken, query, variables),
					catch: (cause) => cause,
				}).pipe(Effect.result);
				if (first._tag === "Success") return first.success;
				if (
					!(first.failure instanceof LinearApiError) ||
					first.failure.status !== 401
				) {
					return yield* Effect.fail(fail(errorMessage(first.failure)));
				}
				bundle = yield* persistBundle({ ...bundle, expiresAt: 0 });
				bundle = yield* freshBundle(workspaceId);
				return yield* Effect.tryPromise({
					try: () =>
						linearGraphql<A>(fetcher, bundle.accessToken, query, variables),
					catch: (cause) => fail(errorMessage(cause)),
				});
			});

		if (shell.onLinearCallbackUrl !== undefined) {
			yield* shell.onLinearCallbackUrl((url) => {
				const current = pending;
				if (current === null) return;
				try {
					const parsed = new URL(url);
					if (parsed.searchParams.get("state") !== current.state) {
						current.reject(new Error("Linear OAuth state did not match."));
					} else {
						current.resolve(url);
					}
				} catch (cause) {
					current.reject(
						cause instanceof Error ? cause : new Error(String(cause)),
					);
				}
			});
		}

		const listConnections = Effect.fn("LinearService.listConnections")(
			function* () {
				const ids = yield* credentials
					.listIntegrationAccounts(INTEGRATION)
					.pipe(Effect.mapError((cause) => fail(cause.reason)));
				const connections: LinearConnection[] = [];
				for (const id of ids) {
					const raw = yield* credentials
						.getIntegration(INTEGRATION, id)
						.pipe(Effect.mapError((cause) => fail(cause.reason)));
					const bundle = parseBundle(raw);
					if (bundle !== null) connections.push(toConnection(bundle));
				}
				return connections.sort((a, b) =>
					a.workspaceName.localeCompare(b.workspaceName),
				);
			},
		);

		const connect = Effect.fn("LinearService.connect")(function* () {
			if (CLIENT_ID.length === 0)
				return yield* Effect.fail(
					fail("Linear OAuth is not configured in this build."),
				);
			if (
				shell.linearRedirectUri === undefined ||
				shell.onLinearCallbackUrl === undefined
			) {
				return yield* Effect.fail(
					fail("This host does not support Linear OAuth."),
				);
			}
			if (pending !== null)
				return yield* Effect.fail(
					fail("A Linear connection is already in progress."),
				);
			const redirectUri = shell.linearRedirectUri;
			const pkce = makePkce();
			const callback = new Promise<string>((resolve, reject) => {
				pending = {
					state: pkce.state,
					verifier: pkce.verifier,
					resolve,
					reject,
				};
			});
			yield* shell
				.open(authorizeUrl(pkce.challenge, pkce.state, redirectUri))
				.pipe(Effect.mapError((cause) => fail(cause.reason)));
			const callbackUrl = yield* Effect.tryPromise({
				try: async () => {
					const timeout = new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("Linear connection timed out.")),
							90_000,
						),
					);
					return await Promise.race([callback, timeout]);
				},
				catch: (cause) => fail(errorMessage(cause)),
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						pending = null;
					}),
				),
			);
			const code = new URL(callbackUrl).searchParams.get("code");
			if (code === null)
				return yield* Effect.fail(
					fail("Linear OAuth returned no authorization code."),
				);
			const token = yield* Effect.tryPromise({
				try: () =>
					exchangeToken(fetcher, {
						grant_type: "authorization_code",
						code,
						redirect_uri: redirectUri,
						client_id: CLIENT_ID,
						code_verifier: pkce.verifier,
					}),
				catch: (cause) => fail(errorMessage(cause)),
			});
			const viewer = yield* Effect.tryPromise({
				try: () =>
					linearGraphql<{
						viewer: {
							id: string;
							name: string;
							email: string;
							organization: { id: string; name: string; urlKey: string };
						};
					}>(fetcher, token.access_token, VIEWER_QUERY, {}),
				catch: (cause) => fail(errorMessage(cause)),
			});
			const now = new Date().toISOString();
			const bundle: TokenBundle = {
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				expiresAt: Date.now() + token.expires_in * 1_000,
				workspaceId: viewer.viewer.organization.id,
				workspaceName: viewer.viewer.organization.name,
				workspaceKey: viewer.viewer.organization.urlKey,
				viewerId: viewer.viewer.id,
				viewerName: viewer.viewer.name,
				viewerEmail: viewer.viewer.email,
				connectedAt: now,
			};
			yield* persistBundle(bundle);
			return toConnection(bundle);
		});

		const disconnect = Effect.fn("LinearService.disconnect")(function* (
			workspaceId: string,
		) {
			const bundle = yield* readBundle(workspaceId);
			yield* Effect.tryPromise({
				try: () =>
					fetcher("https://api.linear.app/oauth/revoke", {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							token: bundle.refreshToken,
							token_type_hint: "refresh_token",
						}),
					}),
				catch: () => null,
			}).pipe(Effect.ignore);
			yield* credentials
				.removeIntegration(INTEGRATION, workspaceId)
				.pipe(Effect.mapError((cause) => fail(cause.reason)));
		});

		const listIssues = Effect.fn("LinearService.listIssues")(function* (input: {
			readonly query?: string;
			readonly workspaceIds?: ReadonlyArray<string>;
			readonly cursor?: string;
		}) {
			const connections = yield* listConnections();
			const requested = new Set(
				input.workspaceIds ?? connections.map((row) => row.workspaceId),
			);
			const selected = connections.filter((row) =>
				requested.has(row.workspaceId),
			);
			const cursorByWorkspace =
				input.cursor === undefined
					? {}
					: (() => {
							try {
								return JSON.parse(
									Buffer.from(input.cursor, "base64url").toString("utf8"),
								) as Record<string, string>;
							} catch {
								return {};
							}
						})();
			const pages = yield* Effect.all(
				selected.map((connection) =>
					Effect.gen(function* () {
						const bundle = yield* freshBundle(connection.workspaceId);
						const request = makeLinearIssueListRequest({
							query: input.query ?? "",
							viewerId: bundle.viewerId,
							after: cursorByWorkspace[connection.workspaceId] ?? null,
						});
						const data = yield* graphql<
							Partial<
								Record<
									"issues" | "issueSearch",
									{
										nodes: ReadonlyArray<IssueSummaryPayload>;
										pageInfo: {
											hasNextPage: boolean;
											endCursor: string | null;
										};
									}
								>
							>
						>(connection.workspaceId, request.document, request.variables);
						const issueConnection = data[request.rootField];
						if (issueConnection === undefined)
							return yield* Effect.fail(
								fail("Linear returned no issue connection."),
							);
						return {
							workspaceId: connection.workspaceId,
							error: null as string | null,
							endCursor: issueConnection.pageInfo.hasNextPage
								? issueConnection.pageInfo.endCursor
								: null,
							issues: issueConnection.nodes.map((issue) =>
								LinearIssueSummary.make({
									workspaceId: connection.workspaceId,
									workspaceName: connection.workspaceName,
									issueId: issue.id,
									identifier: issue.identifier,
									title: issue.title,
									state: issue.state?.name ?? "",
									stateType: issue.state?.type ?? "",
									stateColor: issue.state?.color ?? null,
									priority: issue.priority ?? 0,
									assignee: issue.assignee?.name ?? null,
									assigneeAvatarUrl: issue.assignee?.avatarUrl ?? null,
									labels: (issue.labels?.nodes ?? []).map(
										(label) => label.name,
									),
									updatedAt: new Date(issue.updatedAt),
								}),
							),
						};
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								workspaceId: connection.workspaceId,
								error: error.reason,
								endCursor: null,
								issues: [] as LinearIssueSummary[],
							}),
						),
					),
				),
				{ concurrency: 3 },
			);
			if (selected.length > 0 && pages.every((page) => page.error !== null)) {
				return yield* Effect.fail(
					fail(
						pages
							.map((page) => page.error)
							.filter((message): message is string => message !== null)
							.join("; ") || "Linear issue search failed.",
					),
				);
			}
			const next = Object.fromEntries(
				pages.flatMap((page) =>
					page.endCursor === null ? [] : [[page.workspaceId, page.endCursor]],
				),
			);
			return {
				issues: pages
					.flatMap((page) => page.issues)
					.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
				nextCursor:
					Object.keys(next).length === 0
						? null
						: Buffer.from(JSON.stringify(next)).toString("base64url"),
			};
		});

		const fetchIssueDocument = Effect.fn("LinearService.fetchIssueDocument")(
			function* (workspaceId: string, issueId: string) {
				const connection = (yield* listConnections()).find(
					(row) => row.workspaceId === workspaceId,
				);
				if (connection === undefined)
					return yield* Effect.fail(fail("Linear workspace is not connected."));
				const data = yield* graphql<{ issue: IssueDocumentPayload | null }>(
					workspaceId,
					ISSUE_QUERY,
					{ id: issueId },
				);
				if (data.issue == null)
					return yield* Effect.fail(fail("Linear issue was not found."));
				const issue = data.issue;
				const comments = [...(issue.comments?.nodes ?? [])];
				let commentCursor = issue.comments?.pageInfo?.endCursor ?? null;
				while (
					issue.comments?.pageInfo?.hasNextPage &&
					commentCursor !== null
				) {
					const page = yield* graphql<{
						issue: { comments?: CommentConnection };
					}>(workspaceId, COMMENTS_QUERY, {
						id: issueId,
						after: commentCursor,
					});
					comments.push(...(page.issue.comments?.nodes ?? []));
					if (!page.issue.comments?.pageInfo?.hasNextPage) break;
					commentCursor = page.issue.comments.pageInfo.endCursor ?? null;
				}
				return {
					identifier: issue.identifier,
					title: issue.title,
					url: issue.url,
					workspaceName: connection.workspaceName,
					state: issue.state?.name ?? "",
					priorityLabel: issue.priorityLabel ?? "No priority",
					assignee: issue.assignee?.name ?? null,
					labels: (issue.labels?.nodes ?? []).map((label) => label.name),
					project: issue.project?.name ?? null,
					cycle: issue.cycle?.name ?? null,
					description: issue.description ?? "",
					relations: (issue.relations?.nodes ?? []).map((relation) => ({
						type: relation.type ?? "related",
						identifier: relation.relatedIssue?.identifier ?? "",
						title: relation.relatedIssue?.title ?? "",
					})),
					comments: comments.map((comment) => ({
						author: comment.user?.name ?? "Unknown",
						createdAt: comment.createdAt ?? "",
						body: comment.body ?? "",
					})),
					warnings: [],
				} satisfies LinearIssueDocument;
			},
		);

		const prepareContext = Effect.fn("LinearService.prepareContext")(
			function* (input: {
				readonly sessionId: SessionId;
				readonly issues: ReadonlyArray<LinearIssueRef>;
				readonly rootPath?: string;
			}) {
				const cwd = yield* resolveSessionCwd(
					sql,
					fs,
					input.sessionId,
					input.rootPath,
				);
				if (cwd === null)
					return yield* Effect.fail(
						fail("Could not resolve the session workspace."),
					);
				const files: LinearContextFile[] = [];
				const attachments: AttachmentRef[] = [];
				const warnings: LinearContextWarning[] = [];
				const connections = yield* listConnections();
				for (const ref of input.issues) {
					const connection = connections.find(
						(row) => row.workspaceId === ref.workspaceId,
					);
					const workspaceDir = `${safeSegment(connection?.workspaceKey ?? connection?.workspaceName ?? "workspace")}-${safeSegment(ref.workspaceId).slice(0, 8)}`;
					const dir = pathSvc.join(cwd, ".context", "linear", workspaceDir);
					const assetsDir = pathSvc.join(
						dir,
						"assets",
						safeSegment(ref.identifier).toUpperCase(),
					);
					yield* fs
						.makeDirectory(assetsDir, { recursive: true })
						.pipe(Effect.orDie);
					let document: LinearIssueDocument;
					const fetched = yield* fetchIssueDocument(
						ref.workspaceId,
						ref.issueId,
					).pipe(Effect.result);
					if (fetched._tag === "Failure") {
						const message = fetched.failure.reason;
						warnings.push(LinearContextWarning.make({ issue: ref, message }));
						document = {
							identifier: ref.identifier,
							title: "Context unavailable",
							url: "",
							workspaceName: connection?.workspaceName ?? "Unknown workspace",
							state: "Unknown",
							priorityLabel: "Unknown",
							assignee: null,
							labels: [],
							project: null,
							cycle: null,
							description:
								"The issue could not be downloaded. Use the Linear tools to retry.",
							relations: [],
							comments: [],
							warnings: [message],
						};
					} else {
						document = fetched.success;
					}
					const bundle = yield* freshBundle(ref.workspaceId).pipe(
						Effect.result,
					);
					const imageCache = new Map<string, string>();
					const downloadImage = async (
						rawUrl: string,
					): Promise<string | null> => {
						const cached = imageCache.get(rawUrl);
						if (cached !== undefined) return cached;
						if (rawUrl.startsWith("data:image/")) {
							const match = /^data:([^;,]+)(;base64)?,(.*)$/u.exec(rawUrl);
							if (match === null) return null;
							const mime = match[1];
							const encoding = match[2];
							const encoded = match[3];
							if (mime === undefined || encoded === undefined) return null;
							const ext = imageExtension(mime);
							if (ext === null) return null;
							const bytes =
								encoding === ";base64"
									? Buffer.from(encoded, "base64")
									: Buffer.from(decodeURIComponent(encoded), "utf8");
							if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
							const name = `${createHash("sha256").update(rawUrl).digest("hex").slice(0, 20)}.${ext}`;
							await Effect.runPromise(
								fs.writeFile(pathSvc.join(assetsDir, name), bytes),
							);
							const rel = `assets/${safeSegment(ref.identifier).toUpperCase()}/${name}`;
							imageCache.set(rawUrl, rel);
							return rel;
						}
						let url = new URL(rawUrl);
						for (let redirects = 0; redirects < 4; redirects++) {
							await validatePublicImageUrl(url);
							const headers: Record<string, string> = {};
							if (
								url.hostname === "uploads.linear.app" &&
								bundle._tag === "Success"
							) {
								headers.authorization = `Bearer ${bundle.success.accessToken}`;
							}
							const response = await fetcher(url, {
								headers,
								redirect: "manual",
							});
							if (response.status >= 300 && response.status < 400) {
								const location = response.headers.get("location");
								if (location === null) return null;
								url = new URL(location, url);
								continue;
							}
							if (!response.ok) return null;
							const ext = imageExtension(
								response.headers.get("content-type") ?? "",
							);
							if (ext === null) return null;
							const length = Number(
								response.headers.get("content-length") ?? 0,
							);
							if (length > MAX_IMAGE_BYTES) return null;
							const bytes = new Uint8Array(await response.arrayBuffer());
							if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
							const name = `${createHash("sha256").update(rawUrl).digest("hex").slice(0, 20)}.${ext}`;
							await Effect.runPromise(
								fs.writeFile(pathSvc.join(assetsDir, name), bytes),
							);
							const rel = `assets/${safeSegment(ref.identifier).toUpperCase()}/${name}`;
							imageCache.set(rawUrl, rel);
							return rel;
						}
						return null;
					};
					const description = yield* Effect.promise(() =>
						rewriteMarkdownImages(document.description, downloadImage),
					);
					const commentResults = yield* Effect.all(
						document.comments.map((comment) =>
							Effect.promise(async () => ({
								...comment,
								...(await rewriteMarkdownImages(comment.body, downloadImage)),
							})),
						),
						{ concurrency: 3 },
					);
					const attachmentWarnings: string[] = [];
					for (const relPath of new Set(imageCache.values())) {
						const mimeType = imageMimeFromPath(relPath);
						if (mimeType === null) continue;
						const absPath = pathSvc.join(dir, relPath);
						const bytes = yield* fs.readFile(absPath).pipe(Effect.result);
						if (bytes._tag === "Failure") {
							attachmentWarnings.push(
								`Downloaded image could not be attached to the agent: ${relPath}`,
							);
							continue;
						}
						const originalName = `${safeSegment(ref.identifier).toUpperCase()}-${pathSvc.basename(relPath)}`;
						const uploaded = yield* attachmentService
							.upload(
								input.sessionId,
								bytes.success,
								mimeType,
								originalName,
								cwd,
							)
							.pipe(Effect.result);
						if (uploaded._tag === "Failure") {
							attachmentWarnings.push(
								`Downloaded image could not be attached to the agent: ${relPath}`,
							);
							continue;
						}
						attachments.push(
							AttachmentRef.make({
								id: uploaded.success.id,
								mimeType: uploaded.success.mimeType,
								originalName,
							}),
						);
					}
					const imageWarnings = [
						...description.warnings,
						...commentResults.flatMap((comment) => comment.warnings),
						...attachmentWarnings,
					];
					for (const message of imageWarnings)
						warnings.push(LinearContextWarning.make({ issue: ref, message }));
					const markdown = renderLinearIssueMarkdown({
						...document,
						description: description.markdown,
						comments: commentResults.map(({ markdown, ...comment }) => ({
							...comment,
							body: markdown,
						})),
						warnings: [...document.warnings, ...imageWarnings],
					});
					const filename = `${safeSegment(ref.identifier).toUpperCase()}.md`;
					const target = pathSvc.join(dir, filename);
					const temp = `${target}.tmp-${randomUUID()}`;
					yield* fs.writeFileString(temp, markdown).pipe(Effect.orDie);
					yield* fs.rename(temp, target).pipe(Effect.orDie);
					files.push(
						LinearContextFile.make({
							issue: ref,
							relPath: pathSvc.relative(cwd, target),
							absPath: target,
						}),
					);
				}
				return { files, attachments, warnings };
			},
		);

		const resolveToolIssue = Effect.fn("LinearService.resolveToolIssue")(
			function* (workspaceId: string | undefined, issue: string) {
				const connections = yield* listConnections();
				const candidates =
					workspaceId === undefined
						? connections
						: connections.filter((row) => row.workspaceId === workspaceId);
				const matches: Array<{
					workspaceId: string;
					issue: IssueLookupPayload;
				}> = [];
				for (const connection of candidates) {
					const result = yield* graphql<{
						issue: IssueLookupPayload | null;
					}>(connection.workspaceId, ISSUE_LOOKUP_QUERY, { id: issue }).pipe(
						Effect.result,
					);
					if (result._tag === "Success" && result.success.issue != null)
						matches.push({
							workspaceId: connection.workspaceId,
							issue: result.success.issue,
						});
				}
				if (matches.length === 0)
					return yield* Effect.fail(
						fail(`Linear issue ${issue} was not found.`),
					);
				if (matches.length > 1)
					return yield* Effect.fail(
						fail(
							`Linear issue ${issue} exists in multiple workspaces; provide workspaceId.`,
						),
					);
				const match = matches[0];
				if (match === undefined)
					return yield* Effect.fail(
						fail(`Linear issue ${issue} was not found.`),
					);
				return match;
			},
		);

		const getIssueForTool = Effect.fn("LinearService.getIssueForTool")(
			function* (workspaceId: string | undefined, issue: string) {
				return yield* resolveToolIssue(workspaceId, issue);
			},
		);

		const addComment = Effect.fn("LinearService.addComment")(function* (
			workspaceId: string | undefined,
			issue: string,
			body: string,
		) {
			const resolved = yield* resolveToolIssue(workspaceId, issue);
			return yield* graphql(resolved.workspaceId, COMMENT_MUTATION, {
				issueId: resolved.issue.id,
				body,
			});
		});

		const findNamed = (
			values: ReadonlyArray<NamedNode>,
			requested: string,
			kind: string,
		) => {
			const normalized = requested.trim().toLowerCase();
			const matches = values.filter(
				(value) =>
					value.name?.trim().toLowerCase() === normalized ||
					value.email?.trim().toLowerCase() === normalized,
			);
			if (matches.length !== 1)
				throw new Error(
					matches.length === 0
						? `${kind} “${requested}” was not found.`
						: `${kind} “${requested}” is ambiguous.`,
				);
			const match = matches[0];
			if (match === undefined)
				throw new Error(`${kind} “${requested}” was not found.`);
			return match;
		};

		const updateIssue = Effect.fn("LinearService.updateIssue")(function* (
			input: LinearToolIssueUpdate,
		) {
			const resolved = yield* resolveToolIssue(input.workspaceId, input.issue);
			const current = resolved.issue;
			const update: Record<string, unknown> = {};
			if (input.title !== undefined) update.title = input.title;
			if (input.description !== undefined)
				update.description = input.description;
			if (input.priority !== undefined) update.priority = input.priority;
			try {
				if (input.status !== undefined)
					update.stateId = findNamed(
						current.team?.states?.nodes ?? [],
						input.status,
						"Status",
					).id;
				if (input.assignee !== undefined)
					update.assigneeId =
						input.assignee === null
							? null
							: findNamed(
									current.team?.members?.nodes ?? [],
									input.assignee,
									"Assignee",
								).id;
				if (input.labels !== undefined)
					update.labelIds = input.labels.map(
						(label: string) =>
							findNamed(current.team?.labels?.nodes ?? [], label, "Label").id,
					);
				if (input.project !== undefined) {
					if (input.project === null) update.projectId = null;
					else
						update.projectId = findNamed(
							current.team?.projects?.nodes ?? [],
							input.project,
							"Project",
						).id;
				}
			} catch (cause) {
				return yield* Effect.fail(fail(errorMessage(cause)));
			}
			return yield* graphql(resolved.workspaceId, UPDATE_MUTATION, {
				id: current.id,
				input: update,
			});
		});

		return LinearService.of({
			listConnections,
			connect,
			disconnect,
			listIssues,
			prepareContext,
			getIssueForTool,
			addComment,
			updateIssue,
		});
	}),
);
