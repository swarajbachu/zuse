import {
	type EnvironmentEntry,
	type EnvironmentProject,
	EnvironmentVaultCommand,
} from "@zuse/contracts";
import {
	selectEnvironmentBindings,
	validateEnvironmentBindings,
} from "@zuse/utils/environment";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	openVersionedApiString,
	sealVersionedApiString,
} from "./api-sealing.ts";
import { requireWorkos } from "./auth.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import {
	type ApiError,
	badRequest,
	conflict,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { decodeBody, json } from "./http.ts";

export interface VaultDocument {
	readonly entries: readonly (EnvironmentEntry & { readonly value: string })[];
	readonly projects: readonly EnvironmentProject[];
}
export interface VaultRow {
	readonly revision: number;
	readonly ciphertext: string;
}
export class EnvironmentVaultStore extends Context.Service<
	EnvironmentVaultStore,
	{
		readonly purge: (accountId: string) => Effect.Effect<void, ApiError>;
		readonly audit: (
			owner: string,
			event: string,
		) => Effect.Effect<void, ApiError>;
		readonly load: (owner: string) => Effect.Effect<VaultRow | null, ApiError>;
		readonly commit: (
			owner: string,
			previous: number,
			ciphertext: string,
			audit: string,
		) => Effect.Effect<boolean, ApiError>;
	}
>()("@zuse/api/EnvironmentVaultStore") {}

export const EnvironmentVaultStorePg = Layer.effect(
	EnvironmentVaultStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return EnvironmentVaultStore.of({
			purge: (accountId) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`DELETE FROM api_environment_vaults WHERE owner::jsonb->>0 = ${accountId}`;
							yield* sql`DELETE FROM api_environment_vault_audit WHERE owner::jsonb->>0 = ${accountId}`;
						}),
					)
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("environment_cleanup_failed"),
						),
					),
			audit: (owner, event) =>
				sql`INSERT INTO api_environment_vault_audit (owner, event) VALUES (${owner}, ${event})`.pipe(
					Effect.asVoid,
					Effect.mapError(() =>
						serviceUnavailable("environment_audit_unavailable"),
					),
				),
			load: (owner) =>
				sql<{
					revision: number;
					ciphertext: string;
				}>`SELECT revision, ciphertext FROM api_environment_vaults WHERE owner = ${owner}`.pipe(
					Effect.map((rows) => rows[0] ?? null),
					Effect.mapError(() =>
						serviceUnavailable("environment_storage_unavailable"),
					),
				),
			commit: (owner, previous, ciphertext, audit) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							const rows =
								previous === 0
									? yield* sql`INSERT INTO api_environment_vaults (owner, revision, ciphertext) VALUES (${owner}, 1, ${ciphertext}) ON CONFLICT (owner) DO NOTHING RETURNING revision`
									: yield* sql`UPDATE api_environment_vaults SET revision = ${previous + 1}, ciphertext = ${ciphertext} WHERE owner = ${owner} AND revision = ${previous} RETURNING revision`;
							if (rows.length === 0) return false;
							yield* sql`INSERT INTO api_environment_vault_audit (owner, event) VALUES (${owner}, ${audit})`;
							return true;
						}),
					)
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("environment_storage_unavailable"),
						),
					),
		});
	}),
);

const DocumentSchema = Schema.Struct({
	entries: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			kind: Schema.Literals(["secret", "variable"]),
			scope: Schema.Literals(["personal", "team"]),
			projectIds: Schema.NullOr(Schema.Array(Schema.String)),
			excludedProjectIds: Schema.Array(Schema.String),
			target: Schema.Literals(["both", "local", "cloud"]),
			revision: Schema.Number,
			updatedAt: Schema.Number,
			value: Schema.String,
		}),
	),
	projects: Schema.Array(
		Schema.Struct({ id: Schema.String, name: Schema.String }),
	),
});

export const environmentVaultOwner = (accountId: string, orgId?: string) =>
	JSON.stringify([accountId, orgId ?? null]);
const sealContext = (owner: string, revision: number) =>
	`environment-vault\n${owner}\n${revision}`;
export const loadEnvironmentVault = (owner: string) =>
	Effect.gen(function* () {
		const store = yield* EnvironmentVaultStore;
		const row = yield* store.load(owner);
		if (row === null)
			return {
				revision: 0,
				document: { entries: [], projects: [] } as VaultDocument,
			};
		const plaintext = yield* openVersionedApiString(
			sealContext(owner, row.revision),
			row.ciphertext,
		);
		const document = yield* Effect.try({
			try: () =>
				Schema.decodeUnknownSync(DocumentSchema)(JSON.parse(plaintext)),
			catch: () => serviceUnavailable("environment_storage_invalid"),
		});
		return { revision: row.revision, document };
	});

export const resolveEnvironmentVault = (
	owner: string,
	projectId: string,
	target: "local" | "cloud",
) =>
	Effect.gen(function* () {
		const { revision, document } = yield* loadEnvironmentVault(owner);
		if (!document.projects.some((project) => project.id === projectId)) {
			const store = yield* CloudWorkspaceStore;
			const [accountId, orgId] = JSON.parse(owner) as [string, string | null];
			const projects =
				orgId === null ? yield* store.listProjects(accountId) : [];
			if (!projects.some((project) => project.projectId === projectId))
				return yield* Effect.fail(notFound("environment_project_not_found"));
		}
		const entries = selectEnvironmentBindings(
			document.entries,
			projectId,
			target,
		);
		const auditStore = yield* EnvironmentVaultStore;
		yield* auditStore.audit(
			owner,
			JSON.stringify({
				action: "resolve",
				projectId,
				revision,
				entryIds: entries.map((entry) => entry.id),
				at: Date.now(),
			}),
		);
		return {
			revision,
			projectId,
			values: Object.fromEntries(
				entries.map((entry) => [entry.name, entry.value]),
			),
			secretNames: entries
				.filter((entry) => entry.kind === "secret")
				.map((entry) => entry.name),
			sources: Object.fromEntries(
				entries.map((entry) => [entry.name, entry.id]),
			),
			resolvedAt: Date.now(),
		};
	});

/** Management requires a human account token. Runtime tokens never enter this route. */
export const routeEnvironmentVaultRequest = (request: Request) =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		if (
			url.pathname !== "/v1/environment-vault" &&
			url.pathname !== "/v1/environment-vault/resolve"
		)
			return null;
		const principal = yield* requireWorkos(request);
		const config = yield* ApiConfiguration;
		const maybeStore = yield* Effect.serviceOption(EnvironmentVaultStore);
		if (!config.environmentVaultEnabled || Option.isNone(maybeStore)) {
			return json({
				snapshot: {
					enabled: false,
					teamEnabled: false,
					revision: 0,
					entries: [],
					projects: [],
				},
			});
		}
		const store = maybeStore.value;
		const owner = environmentVaultOwner(principal.accountId, principal.orgId);
		if (request.method !== "POST")
			return yield* Effect.fail(badRequest("invalid_method"));
		const length = Number(request.headers.get("content-length") ?? 0);
		if (length > 1_048_576)
			return yield* Effect.fail(badRequest("environment_request_too_large"));
		const body = yield* Effect.tryPromise({
			try: async () => {
				const reader = request.body?.getReader();
				if (!reader) throw new Error("missing_body");
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						bytes += chunk.value.byteLength;
						if (bytes > 1_048_576) {
							await reader.cancel();
							throw new Error("too_large");
						}
						chunks.push(chunk.value);
					}
				} finally {
					reader.releaseLock();
				}
				const joined = new Uint8Array(bytes);
				let offset = 0;
				for (const chunk of chunks) {
					joined.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return new Request(request.url, { method: "POST", body: joined });
			},
			catch: () => badRequest("invalid_environment_request"),
		});
		if (url.pathname.endsWith("/resolve")) {
			const input = yield* decodeBody(
				Schema.Struct({ projectId: Schema.String }),
				body,
			);
			const resolved = yield* resolveEnvironmentVault(
				owner,
				input.projectId,
				"local",
			).pipe(Effect.provideService(EnvironmentVaultStore, store));
			const response = json(resolved);
			response.headers.set("cache-control", "no-store");
			return response;
		}
		const command = yield* decodeBody(EnvironmentVaultCommand, body);
		const current = yield* loadEnvironmentVault(owner).pipe(
			Effect.provideService(EnvironmentVaultStore, store),
		);
		const cloudStore = yield* CloudWorkspaceStore;
		const cloudProjects = principal.orgId
			? []
			: yield* cloudStore.listProjects(principal.accountId);
		let document: VaultDocument = {
			...current.document,
			projects: [
				...current.document.projects,
				...cloudProjects
					.filter(
						(project) =>
							!current.document.projects.some(
								(item) => item.id === project.projectId,
							),
					)
					.map((project) => ({
						id: project.projectId,
						name: project.displayName,
					})),
			],
		};
		let revision = current.revision;
		let value: string | undefined;
		let projectId: string | undefined;
		let auditEntryId: string | undefined;
		const now = Date.now();
		if (command.action === "reveal") {
			const entry = document.entries.find((entry) => entry.id === command.id);
			if (!entry)
				return yield* Effect.fail(notFound("environment_entry_not_found"));
			yield* store.audit(
				owner,
				JSON.stringify({
					actor: principal.accountId,
					action: "reveal",
					entryId: entry.id,
					revision,
					at: now,
				}),
			);
			value = entry.value;
		} else if (command.action !== "list") {
			if (
				!Number.isSafeInteger(command.expectedRevision) ||
				command.expectedRevision !== revision
			)
				return yield* Effect.fail(conflict("environment_revision_conflict"));
			if (command.action === "project") {
				if (
					!command.name.trim() ||
					command.name.length > 200 ||
					document.projects.length >= 1000
				)
					return yield* Effect.fail(badRequest("invalid_environment_project"));
				projectId = crypto.randomUUID();
				document = {
					...document,
					projects: [
						...document.projects,
						{ id: projectId, name: command.name.trim() },
					],
				};
			} else if (command.action === "delete") {
				if (!document.entries.some((entry) => entry.id === command.id))
					return yield* Effect.fail(notFound("environment_entry_not_found"));
				document = {
					...document,
					entries: document.entries.filter((entry) => entry.id !== command.id),
				};
			} else if (command.action === "save") {
				const previous = document.entries.find(
					(entry) => entry.id === command.entry.id,
				);
				const entryValue = command.value ?? previous?.value;
				if (
					entryValue === undefined ||
					entryValue.includes("\0") ||
					entryValue.length > 65_536 ||
					command.entry.scope !== "personal"
				)
					return yield* Effect.fail(badRequest("invalid_environment_entry"));
				const ids = [
					...(command.entry.projectIds ?? []),
					...command.entry.excludedProjectIds,
				];
				if (
					ids.some(
						(id) => !document.projects.some((project) => project.id === id),
					)
				)
					return yield* Effect.fail(badRequest("invalid_environment_project"));
				const entry = {
					...command.entry,
					id: previous?.id ?? crypto.randomUUID(),
					value: entryValue,
					revision: (previous?.revision ?? 0) + 1,
					updatedAt: now,
				};
				auditEntryId = entry.id;
				document = {
					...document,
					entries: [
						...document.entries.filter((item) => item.id !== entry.id),
						entry,
					],
				};
				if (document.entries.length > 1000)
					return yield* Effect.fail(badRequest("environment_entry_limit"));
				yield* Effect.try({
					try: () => validateEnvironmentBindings(document.entries),
					catch: () => badRequest("environment_assignment_conflict"),
				});
			}
			const plaintext = JSON.stringify(document);
			if (plaintext.length > 1_048_576)
				return yield* Effect.fail(badRequest("environment_vault_too_large"));
			const ciphertext = yield* sealVersionedApiString(
				sealContext(owner, revision + 1),
				plaintext,
			);
			const committed = yield* store.commit(
				owner,
				revision,
				ciphertext,
				JSON.stringify({
					actor: principal.accountId,
					action: command.action,
					entryId:
						"id" in command
							? command.id
							: command.action === "save"
								? auditEntryId
								: undefined,
					revision: revision + 1,
					at: now,
				}),
			);
			if (!committed)
				return yield* Effect.fail(conflict("environment_revision_conflict"));
			revision++;
		}
		const response = json({
			snapshot: {
				enabled: true,
				teamEnabled: false,
				revision,
				entries: document.entries.map(({ value: _value, ...entry }) => entry),
				projects: document.projects,
			},
			...(value === undefined ? {} : { value }),
			...(projectId === undefined ? {} : { projectId }),
		});
		response.headers.set("cache-control", "no-store");
		return response;
	});
