import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	EnvironmentResolved,
	EnvironmentVaultResult,
	type FolderId,
} from "@zuse/contracts";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../app-paths.ts";
import { AuthTokenError } from "../auth/errors.ts";
import { AuthService } from "../auth/services/auth-service.ts";
import { resolveMachineApiUrl } from "../machine/machine-control-service.ts";
import { CredentialsService } from "../provider/services/credentials-service.ts";
import { WorkspaceService } from "../workspace/services/workspace-service.ts";

export interface LaunchEnvironment extends EnvironmentResolved {
	readonly offline: boolean;
}
const empty = (): LaunchEnvironment => ({
	revision: 0,
	values: {},
	secretNames: [],
	sources: {},
	resolvedAt: Date.now(),
	offline: false,
});
export class EnvironmentRuntime extends Context.Service<
	EnvironmentRuntime,
	{
		readonly invalidate?: Effect.Effect<void>;
		readonly resolve: (
			cwd: string,
			folderId?: FolderId,
		) => Effect.Effect<LaunchEnvironment, Error>;
		readonly link: (
			folderId: FolderId,
			projectId: string | null | undefined,
		) => Effect.Effect<string | null, Error>;
		readonly status: (folderId: FolderId) => {
			target?: "local" | "cloud";
			offline?: boolean;
			resolvedAt?: number;
		};
		readonly install: (
			resolve: () => Promise<EnvironmentResolved>,
		) => () => void;
	}
>()("zuse/EnvironmentRuntime") {}

const CacheSchema = Schema.Record(Schema.String, EnvironmentResolved);
const LinkSchema = Schema.Record(Schema.String, Schema.String);
const CACHE_NAMESPACE = "environment-personal-cache";

export const makeEnvironmentRuntimeLayer = (cloud: boolean) =>
	Layer.effect(
		EnvironmentRuntime,
		Effect.gen(function* () {
			const auth = yield* AuthService;
			const credentials = yield* CredentialsService;
			const workspace = yield* WorkspaceService;
			const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
			const { userData } = yield* AppPaths;
			const file = join(userData, "environment-project-links.json");
			let remote: (() => Promise<EnvironmentResolved>) | null = null;
			let writeTail = Promise.resolve();
			let cacheTail = Promise.resolve();
			let cacheGeneration = 0;
			let offlineBlocked = false;
			const status = new Map<
				string,
				{ offline: boolean; resolvedAt: number }
			>();
			const readLinks = async () => {
				try {
					return Schema.decodeUnknownSync(LinkSchema)(
						JSON.parse(await readFile(file, "utf8")),
					);
				} catch (cause) {
					if (
						typeof cause === "object" &&
						cause !== null &&
						"code" in cause &&
						cause.code === "ENOENT"
					)
						return {};
					throw new Error("Environment project links could not be read.");
				}
			};
			const account = async () => {
				const state = await Effect.runPromise(auth.getSession());
				return state._tag === "SignedIn"
					? JSON.stringify([
							state.session.user.id,
							state.session.organizationId,
						])
					: null;
			};
			const clearCache = Effect.gen(function* () {
				cacheGeneration++;
				offlineBlocked = true;
				status.clear();
				if (!credentials.encryptedAtRest) return;
				const accounts =
					yield* credentials.listIntegrationAccounts(CACHE_NAMESPACE);
				for (const id of accounts)
					yield* credentials.removeIntegration(CACHE_NAMESPACE, id);
			}).pipe(Effect.catch(() => Effect.void));
			yield* auth.sessionChanges().pipe(
				Stream.runForEach((state) =>
					state._tag === "SignedOut"
						? clearCache
						: Effect.sync(() => status.clear()),
				),
				Effect.forkScoped,
			);

			return EnvironmentRuntime.of({
				invalidate: clearCache,
				status: (folderId) => ({
					...status.get(folderId),
					target: cloud ? "cloud" : "local",
				}),
				install: (resolve) => {
					remote = resolve;
					return () => {
						if (remote === resolve) remote = null;
					};
				},
				link: (folderId, projectId) =>
					Effect.tryPromise({
						try: async () => {
							if (cloud) {
								if (projectId !== undefined || !remote)
									throw new Error(
										"Cloud projects are linked by the control plane.",
									);
								return (await remote()).projectId ?? null;
							}
							const owner = await account();
							if (!owner)
								throw new Error("Sign in to link an environment project.");
							if (!(await Effect.runPromise(workspace.findById(folderId))))
								throw new Error("Project not found.");
							const key = JSON.stringify([owner, folderId]);
							if (projectId === undefined)
								return (await readLinks())[key] ?? null;
							const pending = writeTail.then(async () => {
								const links = { ...(await readLinks()) };
								if (projectId === null) delete links[key];
								else links[key] = projectId;
								await mkdir(userData, { recursive: true, mode: 0o700 });
								const tmp = `${file}.${crypto.randomUUID()}.tmp`;
								await writeFile(tmp, JSON.stringify(links), { mode: 0o600 });
								await rename(tmp, file);
							});
							writeTail = pending.catch(() => {});
							await pending;
							return projectId;
						},
						catch: () => new Error("Environment project could not be linked."),
					}),
				resolve: (cwd, folderId) =>
					Effect.tryPromise({
						try: async () => {
							if (cloud) {
								if (!remote)
									throw new Error("Cloud environment is still connecting.");
								return { ...(await remote()), offline: false };
							}
							const owner = await account();
							if (!owner) return empty();
							const resolutionGeneration = cacheGeneration;
							const folders = await Effect.runPromise(workspace.list());
							let folder = folderId
								? folders.find((item) => item.id === folderId)
								: folders
										.filter((item) => {
											const rel = relative(item.path, cwd);
											return (
												rel === "" ||
												(!rel.startsWith("..") && !isAbsolute(rel))
											);
										})
										.sort((a, b) => b.path.length - a.path.length)[0];
							if (!folder && !folderId && Option.isSome(sql)) {
								const worktrees = await Effect.runPromise(
									sql.value<{
										project_id: string;
										path: string;
									}>`SELECT project_id, path FROM worktrees`,
								);
								const match = worktrees
									.filter((item) => {
										const rel = relative(item.path, cwd);
										return (
											rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
										);
									})
									.sort((a, b) => b.path.length - a.path.length)[0];
								folder = folders.find((item) => item.id === match?.project_id);
							}
							if (!folder) return empty();
							const existingLinks = await readLinks();
							const hasManagedProjects = Object.keys(existingLinks).some(
								(key) => {
									try {
										return JSON.parse(key)[0] === owner;
									} catch {
										return false;
									}
								},
							);
							let projectId = existingLinks[JSON.stringify([owner, folder.id])];
							if (!projectId) {
								// New local checkouts get their own account identity. Never infer identity from a name or path.
								const tokenResult = await Effect.runPromise(
									Effect.result(auth.getAccessToken()),
								);
								if (tokenResult._tag === "Failure") {
									if (
										!hasManagedProjects &&
										tokenResult.failure instanceof AuthTokenError &&
										tokenResult.failure.code === "network"
									)
										return empty();
									throw new Error(
										"Sign in again to register the environment project.",
									);
								}
								const token = tokenResult.success;
								const name = folder.name;
								const linkKey = JSON.stringify([owner, folder.id]);
								const pending = writeTail.then(async () => {
									const links = { ...(await readLinks()) };
									if (links[linkKey]) return links[linkKey];
									const request = async (body: unknown) => {
										const response = await fetch(
											`${resolveMachineApiUrl()}/v1/environment-vault`,
											{
												method: "POST",
												headers: {
													authorization: `Bearer ${token}`,
													"content-type": "application/json",
												},
												body: JSON.stringify(body),
												signal: AbortSignal.timeout(15_000),
											},
										).catch(() => {
											if (!hasManagedProjects)
												return Response.json({
													snapshot: {
														enabled: false,
														teamEnabled: false,
														revision: 0,
														entries: [],
														projects: [],
													},
												});
											throw new Error("Environment vault is offline.");
										});
										if (!response.ok)
											throw new Error(
												"Environment project registration failed.",
											);
										return Schema.decodeUnknownSync(EnvironmentVaultResult)(
											await response.json(),
										);
									};
									const current = await request({ action: "list" });
									if (!current.snapshot.enabled) return null;
									const created = await request({
										action: "project",
										expectedRevision: current.snapshot.revision,
										name,
									});
									if (!created.projectId)
										throw new Error("Environment project registration failed.");
									if (
										(await account()) !== owner ||
										resolutionGeneration !== cacheGeneration
									)
										throw new Error(
											"Account changed during project registration.",
										);
									links[linkKey] = created.projectId;
									await mkdir(userData, { recursive: true, mode: 0o700 });
									const tmp = `${file}.${crypto.randomUUID()}.tmp`;
									await writeFile(tmp, JSON.stringify(links), { mode: 0o600 });
									await rename(tmp, file);
									return created.projectId;
								});
								writeTail = pending.then(
									() => {},
									() => {},
								);
								projectId = (await pending) ?? undefined;
								if (!projectId) return empty();
							}
							const finish = (value: LaunchEnvironment) => {
								if (resolutionGeneration !== cacheGeneration)
									throw new Error("Environment changed during launch. Retry.");
								status.set(folder.id, {
									offline: value.offline,
									resolvedAt: value.resolvedAt,
								});
								return value;
							};
							const cache = async () => {
								if (!credentials.encryptedAtRest) return {};
								const raw = await Effect.runPromise(
									credentials.getIntegration(CACHE_NAMESPACE, owner),
								);
								return raw === null
									? {}
									: Schema.decodeUnknownSync(CacheSchema)(JSON.parse(raw));
							};
							// Authentication failures are intentionally outside the network fallback.
							let token: string;
							const tokenResult = await Effect.runPromise(
								Effect.result(auth.getAccessToken()),
							);
							if (tokenResult._tag === "Failure") {
								if (
									tokenResult.failure instanceof AuthTokenError &&
									tokenResult.failure.code === "network" &&
									(await account()) === owner
								) {
									const cached = (await cache())[projectId];
									if (cached && !offlineBlocked)
										return finish({ ...cached, offline: true });
								}
								await Effect.runPromise(clearCache);
								throw new Error("Sign in again to use environment secrets.");
							}
							token = tokenResult.success;
							let response: Response;
							try {
								response = await fetch(
									`${resolveMachineApiUrl()}/v1/environment-vault/resolve`,
									{
										method: "POST",
										headers: {
											authorization: `Bearer ${token}`,
											"content-type": "application/json",
										},
										body: JSON.stringify({ projectId }),
										signal: AbortSignal.timeout(15_000),
									},
								);
							} catch {
								const cached = (await cache())[projectId];
								if (cached && !offlineBlocked && (await account()) === owner)
									return finish({ ...cached, offline: true });
								throw new Error(
									"Environment vault is offline and no encrypted personal cache is available.",
								);
							}
							if (!response.ok) {
								if ([401, 403, 404].includes(response.status))
									await Effect.runPromise(clearCache);
								throw new Error(
									"Environment access could not be authorized. Reconnect and retry.",
								);
							}
							const payload: unknown = await response.json();
							if (
								typeof payload === "object" &&
								payload !== null &&
								"snapshot" in payload
							) {
								await Effect.runPromise(clearCache);
								return empty();
							}
							const resolved =
								Schema.decodeUnknownSync(EnvironmentResolved)(payload);
							if ((await account()) !== owner)
								throw new Error(
									"Account changed during environment resolution.",
								);
							if (credentials.encryptedAtRest) {
								const id = projectId;
								const pending = cacheTail.then(async () => {
									if (
										(await account()) !== owner ||
										resolutionGeneration !== cacheGeneration
									)
										throw new Error(
											"Account changed during environment resolution.",
										);
									await Effect.runPromise(
										credentials.setIntegration(
											CACHE_NAMESPACE,
											owner,
											JSON.stringify({ ...(await cache()), [id]: resolved }),
										),
									);
									if (
										(await account()) !== owner ||
										resolutionGeneration !== cacheGeneration
									) {
										await Effect.runPromise(clearCache);
										throw new Error(
											"Account changed during environment resolution.",
										);
									}
								});
								cacheTail = pending.catch(() => {});
								await pending;
							}
							const finished = finish({ ...resolved, offline: false });
							offlineBlocked = false;
							return finished;
						},
						catch: (cause) =>
							cause instanceof Error
								? cause
								: new Error("Environment resolution failed."),
					}),
			});
		}),
	);
