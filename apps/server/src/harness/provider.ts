import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrchestrationSessionTools } from "@zuse/agents/drivers/orchestration-tools";
import { SimulatorTools } from "@zuse/agents/drivers/simulator-tools";
import { AccountBroker } from "@zuse/agents/harness/account-broker";
import { digest } from "@zuse/agents/harness/cache";
import { requestModel } from "@zuse/agents/harness/model";
import { contextLimits } from "@zuse/agents/harness/prompt";
import type {
	HarnessEvent,
	HarnessModelInput,
} from "@zuse/agents/harness/types";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type { ProviderSessionHandle } from "@zuse/agents/kernel/driver";
import { isSensitivePath } from "@zuse/agents/kernel/permission-policy";
import type { ModelConnectionProvider } from "@zuse/contracts";
import {
	AgentAvailability,
	type AgentSessionId,
	AgentSessionStartError,
	type RuntimeMode,
	type StartSessionInput,
} from "@zuse/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { AppPaths } from "../app-paths.ts";
import { makeKeyedSwrCache } from "../cache/swr-cache.ts";
import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import {
	PermissionService,
	type RequestOptions,
} from "../provider/services/permission-service.ts";
import { simulatorHarnessTools } from "../simulators/harness.ts";
import { SkillDiscoveryService } from "../skill/services/skill-discovery.ts";
import { ModelConnections } from "./connections-service.ts";
import { makeHarnessJournal } from "./journal.ts";
import { combineAppTools, createNativeHarness } from "./native-runtime.ts";
import { makeHarnessOrchestrationTools } from "./orchestration-tools.ts";
import { makeHarnessSession } from "./provider-session.ts";
import { resolveHarnessRipgrep } from "./ripgrep.ts";

export function parseHarnessModel(id: string): {
	provider: ModelConnectionProvider;
	model: string;
} {
	const match = /^(chatgpt|supergrok)\/([^\s/]+)$/.exec(id);
	if (!match)
		throw new Error(
			"Choose a ChatGPT or SuperGrok model from the Zuse picker.",
		);
	return {
		provider: match[1] === "supergrok" ? "supergrok" : "chatgpt",
		model: match[2] ?? "",
	};
}
const Inventory = Schema.Array(
	Schema.Struct({
		id: Schema.String,
		label: Schema.String,
		liveMeta: Schema.optional(
			Schema.Struct({
				contextWindowTokens: Schema.Number,
				autoCompactTokenLimit: Schema.optional(Schema.Number),
				effectiveContextWindowPercent: Schema.optional(Schema.Number),
			}),
		),
	}),
);
type Inventory = typeof Inventory.Type;
export class HarnessProvider extends Context.Service<
	HarnessProvider,
	{
		readonly availability: () => Effect.Effect<AgentAvailability>;
		readonly inventory: () => Effect.Effect<Inventory, Error>;
		readonly fingerprint: () => Effect.Effect<string>;
		readonly start: (
			input: StartSessionInput,
			cwd: string,
			sessionId: AgentSessionId,
			resumeCursor: string | null,
			runtimeMode: () => RuntimeMode,
			permissionAuthority?: Pick<RequestOptions, "owner" | "isCurrent">,
			orchestrationTools?: OrchestrationSessionTools | null,
		) => Effect.Effect<ProviderSessionHandle, AgentSessionStartError>;
	}
>()("zuse/HarnessProvider") {}

export const HarnessProviderLive = Layer.effect(
	HarnessProvider,
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const connections = yield* ModelConnections;
		const config = yield* ConfigStoreService;
		const permissions = yield* PermissionService;
		const attachments = yield* AttachmentService;
		const skillsService = yield* Effect.serviceOption(SkillDiscoveryService);
		const simulators = yield* Effect.serviceOption(SimulatorTools);
		const discover = (cwd: string) =>
			Option.isSome(skillsService)
				? Effect.runPromise(skillsService.value.discover("zuse", cwd)).then(
						(skills) => skills.filter((skill) => skill.enabled),
					)
				: Promise.resolve([]);
		const journals =
			yield* Effect.context<
				import("effect/unstable/sql").SqlClient.SqlClient
			>();
		const metadata = () => Effect.runPromise(connections.status());
		const cache = yield* makeKeyedSwrCache<string, Inventory, Error>({
			name: "harness:model-inventory",
			ttlMs: 15 * 60 * 1000,
			errorTtlMs: 15000,
			persist: {
				pathFor: (id) =>
					join(
						paths.userData,
						"cache",
						"harness-models-v3",
						`${digest(id)}.json`,
					),
				schema: Inventory,
			},
			load: (id) =>
				Effect.tryPromise(async () => {
					const credential = await Effect.runPromise(
						connections.credential(id),
					);
					const endpoint =
						credential.provider === "supergrok"
							? "https://api.x.ai/v1/models"
							: "https://api.openai.com/v1/models";
					const response = await fetch(endpoint, {
						headers: { authorization: `Bearer ${credential.accessToken}` },
						signal: AbortSignal.timeout(10000),
						redirect: "error",
					});
					if (!response.ok)
						throw new Error(
							`Model inventory unavailable (HTTP ${response.status}). Reconnect or retry.`,
						);
					const body: unknown = await response.json();
					if (!body || typeof body !== "object")
						throw new Error("Invalid model inventory");
					const rows = Reflect.get(
						body,
						credential.provider === "supergrok" ? "data" : "models",
					);
					if (!Array.isArray(rows)) throw new Error("Invalid model inventory");
					const prefix = credential.provider ?? "chatgpt";
					const models: Array<Inventory[number]> = [];
					for (const row of rows) {
						if (!row || typeof row !== "object") continue;
						if (prefix === "chatgpt" && row.visibility !== "list") continue;
						const id = prefix === "supergrok" ? row.id : row.slug;
						if (typeof id !== "string" || !id || /\s|\//.test(id)) continue;
						if (
							prefix === "supergrok" &&
							/image|video|imagine|embed|voice|audio/i.test(id)
						)
							continue;
						const reportedWindow = row.context_window ?? row.max_context_window;
						const contextWindowTokens =
							typeof reportedWindow === "number" &&
							Number.isSafeInteger(reportedWindow) &&
							reportedWindow > 0
								? reportedWindow
								: undefined;
						models.push({
							...(contextWindowTokens === undefined
								? {}
								: {
										liveMeta: {
											contextWindowTokens,
											...(Number.isSafeInteger(row.auto_compact_token_limit) &&
											row.auto_compact_token_limit > 0
												? {
														autoCompactTokenLimit: row.auto_compact_token_limit,
													}
												: {}),
											...(typeof row.effective_context_window_percent ===
												"number" &&
											row.effective_context_window_percent > 0 &&
											row.effective_context_window_percent <= 100
												? {
														effectiveContextWindowPercent:
															row.effective_context_window_percent,
													}
												: {}),
										},
									}),
							id: `${prefix}/${id}`,
							label:
								typeof row.display_name === "string" ? row.display_name : id,
						});
					}
					return { _tag: "value" as const, value: models };
				}).pipe(
					Effect.mapError(
						() =>
							new Error(
								"Model inventory could not be loaded. Reconnect the account or refresh models.",
							),
					),
				),
		});
		const known = new Set<string>();
		const names = new Map<string, string>();
		const listeners = new Map<string, (event: HarnessEvent) => void>();
		const sync = async () => {
			const status = await metadata();
			names.clear();
			for (const c of status.connections)
				names.set(
					c.id,
					c.name.includes("@")
						? c.provider === "supergrok"
							? "SuperGrok"
							: "ChatGPT"
						: c.name,
				);
			const live = new Set(
				status.connections.filter((c) => c.authorized).map((c) => c.id),
			);
			for (const id of known)
				if (!live.has(id)) {
					await Effect.runPromise(cache.remove(id));
					known.delete(id);
					broker.forget(id);
				}
			for (const id of live) known.add(id);
			return status;
		};
		const models = async (id: string): Promise<Inventory> => {
			const entry = await Effect.runPromise(cache.forKey(id));
			if (await Effect.runPromise(entry.isStale()))
				return (await Effect.runPromise(entry.refresh())).value;
			const result = await Effect.runPromise(entry.get());
			if (Option.isNone(result))
				return (await Effect.runPromise(entry.refresh())).value;
			return result.value.value;
		};
		const broker = new AccountBroker({
			connections: async (input?: HarnessModelInput) => {
				const requested = input ? parseHarnessModel(input.model) : null;
				const status = await sync();
				const candidates = status.connections.filter(
					(c) =>
						c.authorized &&
						(!requested || (c.provider ?? "chatgpt") === requested.provider),
				);
				const eligible = await Promise.all(
					candidates.map(async (c) => {
						try {
							return {
								id: c.id,
								preferred: c.preferred,
								authorized:
									!input ||
									(await models(c.id)).some((m) => m.id === input.model),
							};
						} catch {
							return { id: c.id, preferred: c.preferred, authorized: false };
						}
					}),
				);
				return eligible;
			},
			request: async (id, input) => {
				const settings = await Effect.runPromise(config.getSettings());
				if (settings.providerEnabled.zuse !== true)
					throw new Error("Zuse Experimental is disabled in Agent providers.");
				const selected = parseHarnessModel(input.model);
				const credential = await Effect.runPromise(connections.credential(id));
				if ((credential.provider ?? "chatgpt") !== selected.provider)
					throw new Error("Connection provider mismatch");
				return requestModel({ ...input, model: selected.model }, credential);
			},
			switched: (rootId, previous, next) =>
				listeners.get(rootId)?.({
					type: "account",
					agentId: rootId,
					name: names.get(next) ?? "Connected account",
					switched: previous !== null,
				}),
		});
		return {
			fingerprint: () =>
				connections.status().pipe(
					Effect.map((s) =>
						JSON.stringify(
							s.connections.map((c) => [c.id, c.clientId, c.authorized]),
						),
					),
					Effect.catch(() => Effect.succeed("unavailable")),
				),
			inventory: () =>
				Effect.tryPromise(async () => {
					const status = await sync();
					const results = await Promise.all(
						status.connections
							.filter((c) => c.authorized)
							.map((c) => models(c.id).catch(() => [])),
					);
					return [...new Map(results.flat().map((m) => [m.id, m])).values()];
				}).pipe(Effect.mapError(() => new Error("Connections unavailable"))),
			availability: () =>
				Effect.gen(function* () {
					const status = yield* connections
						.status()
						.pipe(
							Effect.catch(() =>
								Effect.succeed({ available: false, connections: [] }),
							),
						);
					const authorized = status.connections.some((c) => c.authorized);

					return AgentAvailability.make({
						providerId: "zuse",
						displayName: "Zuse (Experimental)",
						runtimeKind: "bundledSdk",
						runtimeAvailable: status.available,
						cliInstalled: false,
						cliLoggedIn: false,
						hasApiKey: false,
						authStatus: authorized ? "authenticated" : "unauthenticated",
						authType: "subscription",
						status: !status.available
							? "disabled"
							: authorized
								? "ready"
								: "warning",
						statusMessage: authorized
							? undefined
							: "Connect ChatGPT or SuperGrok in Agent providers.",
						lastCheckedAt: new Date(),
					});
				}),
			start: (
				input,
				cwd,
				sessionId,
				resumeCursor,
				runtimeMode,
				permissionAuthority,
				orchestrationTools,
			) =>
				Effect.gen(function* () {
					const settings = yield* config.getSettings();
					if (settings.providerEnabled.zuse !== true)
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: "zuse",
								reason: "Enable Zuse (Experimental) in Agent providers first.",
							}),
						);
					if (!(yield* connections.status()).available)
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: "zuse",
								reason:
									"Zuse Experimental is not available for this signed-in account.",
							}),
						);
					if (!input.model)
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: "zuse",
								reason: "Choose a Zuse model before starting a chat.",
							}),
						);
					const selected = yield* Effect.try({
						try: () => parseHarnessModel(input.model ?? ""),
						catch: () =>
							new AgentSessionStartError({
								providerId: "zuse",
								reason:
									"Choose a ChatGPT or SuperGrok model from the Zuse picker.",
							}),
					});
					const context = yield* Effect.tryPromise(async () => {
						const status = await sync();
						const inventories = await Promise.all(
							status.connections
								.filter(
									(c) =>
										c.authorized &&
										(c.provider ?? "chatgpt") === selected.provider,
								)
								.map((c) => models(c.id).catch(() => [])),
						);
						const limits = inventories
							.flat()
							.filter((model) => model.id === input.model)
							.map((model) =>
								contextLimits(
									model.liveMeta?.contextWindowTokens,
									model.liveMeta?.autoCompactTokenLimit,
									model.liveMeta?.effectiveContextWindowPercent,
								),
							);

						if (!limits.length) limits.push(contextLimits());
						const windowTokens = Math.min(
							...limits.map((limit) => limit.windowTokens),
						);
						return {
							windowTokens,
							autoCompactTokenLimit: Math.min(
								...limits.map((limit) => limit.compactAt),
							),
							effectiveContextWindowPercent:
								(Math.min(...limits.map((limit) => limit.usableTokens)) /
									windowTokens) *
								100,
						};
					});
					const rootId = `zuse:${sessionId}`;
					if (resumeCursor !== null && resumeCursor !== rootId)
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: "zuse",
								reason: "The Zuse resume cursor does not belong to this chat.",
							}),
						);
					if (input.forkFromResume)
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: "zuse",
								reason: "Use transcript copying when forking a Zuse chat.",
							}),
						);
					const journal = yield* makeHarnessJournal(rootId).pipe(
						Effect.provide(journals),
					);
					return yield* makeHarnessSession({
						sessionId,
						rootId,
						model: input.model,
						permissionMode: input.permissionMode ?? "default",
						onClose: () => {
							broker.removeRoot(rootId);
							listeners.delete(rootId);
						},
						create: (callbacks) => {
							listeners.set(rootId, callbacks.notify);
							return createNativeHarness({
								rootId,
								model: input.model ?? "",
								dataDirectory: paths.userData,
								appTools: combineAppTools(
									orchestrationTools
										? makeHarnessOrchestrationTools(orchestrationTools.deps, {
												getRuntimeMode: runtimeMode,
												requestPermission: (context) => (kind, options) =>
													Effect.runPromise(
														permissions.request(sessionId, kind, {
															...permissionAuthority,
															...options,
															projectId: input.folderId,
														}),
														{ signal: context.signal },
													),
											})
										: undefined,
									Option.isSome(simulators)
										? simulatorHarnessTools({
												client: simulators.value,
												sessionId,
												getRuntimeMode: runtimeMode,
												requestPermission: (kind, options, signal) =>
													Effect.runPromise(
														permissions.request(sessionId, kind, {
															...permissionAuthority,
															...options,
															projectId: input.folderId,
														}),
														{ signal },
													),
											})
										: undefined,
								),
								host: {
									...journal,
									load: async () => {
										const state = await journal.load();
										if (resumeCursor !== null && state === null)
											throw new Error(
												"The saved execution journal is missing. Restore it before resuming this chat.",
											);
										return state;
									},
									notify: callbacks.notify,
									model: (request) => broker.request(request),
									automaticNotifications: false,
									...context,
									enableSubagents: input.enableSubagents,
									reasoning:
										typeof input.modelOptions?.reasoning === "string"
											? input.modelOptions.reasoning
											: undefined,
									instructions: async () => {
										const sections = [
											input.workspaceInstructions ?? "",
											"Read applicable AGENTS.md files before editing. Child agents share this checkout; coordinate file ownership. Background process notices are delivered during active turns or on your next message.",
										];
										for (const name of ["AGENTS.md", "CLAUDE.md"]) {
											try {
												const body = await readFile(join(cwd, name), "utf8");
												sections.push(`${name}:\n${body.slice(0, 100000)}`);
											} catch (error) {
												if (
													!(
														error instanceof Error &&
														"code" in error &&
														error.code === "ENOENT"
													)
												)
													throw error;
											}
										}
										const skills = await discover(cwd);
										sections.push(
											"Available skills (read the skill file when needed):\n" +
												skills
													.map(
														(skill) =>
															`${skill.name}: ${skill.description} (${skill.filePath})`,
													)
													.join("\n"),
										);
										return sections.join("\n\n");
									},
								},
								tools: {
									cwd,
									env: { ...process.env, ...input.executionEnv },
									runtimeMode,
									ripgrep: resolveHarnessRipgrep(),
									question: callbacks.question,
									plan: callbacks.plan,
									approve: async (request, context) => {
										const kind =
											request.path &&
											["write_file", "edit_file", "multi_edit"].includes(
												request.name,
											)
												? { _tag: "FileWrite" as const, path: request.path }
												: request.name === "exec_command"
													? {
															_tag: "Bash" as const,
															command: String(
																request.input &&
																	typeof request.input === "object"
																	? (Reflect.get(request.input, "command") ??
																			"")
																	: "",
															),
														}
													: {
															_tag: "Other" as const,
															tool: request.name,
															summary: JSON.stringify(request.input).slice(
																0,
																2000,
															),
														};
										const decision = await Effect.runPromise(
											permissions.request(sessionId, kind, {
												...permissionAuthority,
												projectId: input.folderId,
												forcePrompt:
													request.path !== undefined &&
													isSensitivePath(request.path),
											}),
											{ signal: context.signal },
										);
										return decision._tag !== "Deny";
									},
								},
							}).catch((error) => {
								listeners.delete(rootId);
								throw error;
							});
						},
						prepare: async (text, refs = [], files = [], skills = []) => {
							const images: Array<{ mediaType: string; data: string }> = [];
							for (const ref of refs) {
								const file = await Effect.runPromise(
									attachments.readForSession(sessionId, ref.id),
								);
								if (!file) throw new Error("Attachment unavailable");
								if (
									![
										"image/png",
										"image/jpeg",
										"image/gif",
										"image/webp",
									].includes(file.mimeType)
								)
									throw new Error(
										"Use a file reference for non-image attachments",
									);
								images.push({
									mediaType: file.mimeType,
									data: Buffer.from(file.bytes).toString("base64"),
								});
							}
							const available = await discover(cwd);
							const instructions: string[] = [];
							for (const ref of skills) {
								const skill = available.find(
									(s) => s.name === ref.name && s.scope === ref.scope,
								);
								if (!skill?.filePath)
									throw new Error("Selected skill is unavailable");
								instructions.push(
									`Skill ${skill.name}:\n${(await readFile(skill.filePath, "utf8")).slice(0, 100000)}\nArguments: ${ref.args}`,
								);
							}
							return {
								text: [
									text,
									...files.map((f) => `Referenced ${f.kind}: ${f.absPath}`),
									...instructions,
								].join("\n"),
								images,
							};
						},
					});
				}).pipe(
					Effect.catch((error) =>
						Effect.fail(
							error instanceof AgentSessionStartError
								? error
								: new AgentSessionStartError({
										providerId: "zuse",
										reason:
											"Zuse could not start. Enable the experiment, connect an account, and choose an available model. If resuming, preserve the execution journal and inspect the last step.",
									}),
						),
					),
				),
		};
	}),
);
