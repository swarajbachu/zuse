import type { AlertRule } from "./automation.ts";

export interface Database {
	query<T extends Record<string, unknown>>(
		sql: string,
		values?: readonly (string | number | null)[],
	): Promise<readonly T[]>;
}
export interface Cipher {
	seal(context: string, value: string): Promise<string>;
	open(context: string, value: string): Promise<string>;
}
export type AccessMode = "installer" | "shared" | "personal";
export interface ZuseConnection {
	readonly accountId: string;
	readonly webhookId: string;
	readonly webhookSecret: string;
	readonly agent?: string;
	readonly model?: string;
	readonly projectId?: string;
}
export interface MemberProfile {
	readonly revision: number;
	readonly connection: ZuseConnection | null;
	readonly defaults: {
		readonly replyMode?: "mentions" | "all";
		readonly projectId?: string;
		readonly channels: Readonly<Record<string, string>>;
	};
}
export interface Installation {
	readonly teamId: string;
	readonly ownerId: string;
	readonly generation: string;
	readonly revision: number;
	readonly credentials: {
		readonly botToken: string;
		readonly userToken: string;
		readonly botUserId: string;
		readonly accessMode?: AccessMode;
		readonly zuse?: ZuseConnection;
		readonly rules: ReadonlyArray<AlertRule>;
	};
}
type Row = {
	team_id: string;
	owner_id: string;
	generation: string;
	revision: number;
	sealed: string;
};
type Session = {
	team_id: string;
	owner_id: string;
	generation: string;
	payload: string;
};
type SessionKind = "oauth" | "login" | "settings" | "workos";
const encoder = new TextEncoder();
export const randomSecret = (): string =>
	[...crypto.getRandomValues(new Uint8Array(32))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
const hash = async (value: string): Promise<string> =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(value)),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
const installationContext = (
	i: Pick<Installation, "teamId" | "ownerId" | "generation">,
) => ["slack-installation", i.teamId, i.ownerId, i.generation].join("\n");

/** PostgreSQL persistence using the API's shared credential/content cipher. */
export class InstallationStore {
	constructor(
		private readonly db: Database,
		private readonly cipher: Cipher,
	) {}
	async get(teamId: string): Promise<Installation | null> {
		const row = (
			await this.db.query<Row>(
				"SELECT * FROM api_slack_installations WHERE team_id = $1",
				[teamId],
			)
		)[0];
		if (!row) return null;
		const identity = {
			teamId: row.team_id,
			ownerId: row.owner_id,
			generation: row.generation,
			revision: Number(row.revision),
		};
		return {
			...identity,
			credentials: JSON.parse(
				await this.cipher.open(installationContext(identity), row.sealed),
			),
		};
	}
	async install(installation: Installation): Promise<boolean> {
		const rows = await this.db.query(
			"INSERT INTO api_slack_installations (team_id, owner_id, generation, revision, sealed, account_id) VALUES ($1, $2, $3, 0, $4, $5) ON CONFLICT(team_id) DO NOTHING RETURNING team_id",
			[
				installation.teamId,
				installation.ownerId,
				installation.generation,
				await this.cipher.seal(
					installationContext(installation),
					JSON.stringify(installation.credentials),
				),
				installation.credentials.zuse?.accountId ?? null,
			],
		);
		return rows.length === 1;
	}
	async save(
		installation: Installation,
		credentials: Installation["credentials"],
	): Promise<boolean> {
		const rows = await this.db.query(
			"UPDATE api_slack_installations SET sealed = $1, account_id = $2, revision = revision + 1 WHERE team_id = $3 AND owner_id = $4 AND generation = $5 AND revision = $6 RETURNING team_id",
			[
				await this.cipher.seal(
					installationContext(installation),
					JSON.stringify(credentials),
				),
				credentials.zuse?.accountId ?? null,
				installation.teamId,
				installation.ownerId,
				installation.generation,
				installation.revision,
			],
		);
		return rows.length === 1;
	}
	async remove(installation: Installation): Promise<void> {
		await this.db.query(
			"DELETE FROM api_slack_installations WHERE team_id = $1 AND generation = $2",
			[installation.teamId, installation.generation],
		);
		await this.db.query(
			"DELETE FROM api_slack_sessions WHERE team_id = $1 AND generation = $2",
			[installation.teamId, installation.generation],
		);
	}
	async removeAccount(accountId: string): Promise<void> {
		const members = await this.db.query<{ team_id: string; user_id: string }>(
			"SELECT team_id, user_id FROM api_slack_members WHERE account_id = $1",
			[accountId],
		);
		for (const row of members) {
			const installation = await this.get(row.team_id);
			if (!installation) continue;
			const profile = await this.member(installation, row.user_id);
			if (profile.connection?.accountId !== accountId) continue;
			if (
				!(await this.saveMember(installation, row.user_id, {
					...profile,
					connection: null,
					defaults: { channels: {} },
				}))
			)
				throw new Error("slack_account_cleanup_conflict");
			await this.db.query(
				"DELETE FROM api_slack_sessions WHERE team_id=$1 AND generation=$2 AND owner_id=$3",
				[installation.teamId, installation.generation, row.user_id],
			);
		}
		const legacy = await this.db.query<{ team_id: string }>(
			"SELECT team_id FROM api_slack_installations WHERE account_id=$1",
			[accountId],
		);
		for (const row of legacy) {
			const installation = await this.get(row.team_id);
			if (
				!installation ||
				installation.credentials.zuse?.accountId !== accountId
			)
				continue;
			const profile = await this.member(installation, installation.ownerId);
			if (profile.revision === -1) await this.remove(installation);
			else if (
				!(await this.save(installation, {
					...installation.credentials,
					zuse: undefined,
				}))
			)
				throw new Error("slack_account_cleanup_conflict");
		}
	}
	async member(
		installation: Installation,
		userId: string,
	): Promise<MemberProfile> {
		const row = (
			await this.db.query<{ revision: number; sealed: string }>(
				"SELECT revision, sealed FROM api_slack_members WHERE team_id = $1 AND generation = $2 AND user_id = $3",
				[installation.teamId, installation.generation, userId],
			)
		)[0];
		if (row)
			return {
				...JSON.parse(
					await this.cipher.open(
						[
							"slack-member",
							installation.teamId,
							installation.generation,
							userId,
						].join("\n"),
						row.sealed,
					),
				),
				revision: Number(row.revision),
			};
		const legacy =
			userId === installation.ownerId
				? installation.credentials.zuse
				: undefined;
		return {
			revision: -1,
			connection: legacy ?? null,
			defaults: {
				...(legacy?.projectId ? { projectId: legacy.projectId } : {}),
				channels: {},
			},
		};
	}
	async saveMember(
		installation: Installation,
		userId: string,
		profile: MemberProfile,
	): Promise<boolean> {
		const sealed = await this.cipher.seal(
			[
				"slack-member",
				installation.teamId,
				installation.generation,
				userId,
			].join("\n"),
			JSON.stringify({
				connection: profile.connection,
				defaults: profile.defaults,
			}),
		);
		const values = [
			installation.teamId,
			installation.generation,
			userId,
			profile.connection?.accountId ?? null,
			sealed,
		];
		const rows =
			profile.revision === -1
				? await this.db.query(
						"INSERT INTO api_slack_members (team_id, generation, user_id, account_id, sealed, revision) VALUES ($1,$2,$3,$4,$5,0) ON CONFLICT(team_id,generation,user_id) DO NOTHING RETURNING user_id",
						values,
					)
				: await this.db.query(
						"UPDATE api_slack_members SET account_id=$4, sealed=$5, revision=revision+1 WHERE team_id=$1 AND generation=$2 AND user_id=$3 AND revision=$6 RETURNING user_id",
						[...values, profile.revision],
					);
		return rows.length === 1;
	}
	state(installation: Pick<Installation, "teamId" | "generation">) {
		const context = (key: string) =>
			["slack-state", installation.teamId, installation.generation, key].join(
				"\n",
			);
		return {
			get: async (key: string): Promise<string | null> => {
				const row = (
					await this.db.query<{ value: string }>(
						"SELECT value FROM api_slack_state WHERE team_id = $1 AND generation = $2 AND key = $3 AND expires_at > $4",
						[installation.teamId, installation.generation, key, Date.now()],
					)
				)[0];
				return row ? this.cipher.open(context(key), row.value) : null;
			},
			put: async (
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			): Promise<void> => {
				await this.db.query(
					"DELETE FROM api_slack_state WHERE expires_at < $1",
					[Date.now()],
				);
				await this.db.query(
					"INSERT INTO api_slack_state (team_id, generation, key, value, expires_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(team_id, generation, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
					[
						installation.teamId,
						installation.generation,
						key,
						await this.cipher.seal(context(key), value),
						Date.now() + (options?.expirationTtl ?? 86400) * 1000,
					],
				);
			},
		};
	}
	async session(
		kind: SessionKind,
		installation?: Installation,
		payload = "",
		userId = installation?.ownerId ?? "",
	): Promise<string> {
		const token = randomSecret();
		const digest = await hash(token);
		await this.db.query(
			"DELETE FROM api_slack_sessions WHERE expires_at < $1",
			[Date.now()],
		);
		await this.db.query(
			"INSERT INTO api_slack_sessions (token_hash, kind, team_id, owner_id, generation, expires_at, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)",
			[
				digest,
				kind,
				installation?.teamId ?? "",
				userId,
				installation?.generation ?? "",
				Date.now() + (kind === "settings" ? 3_600_000 : 600_000),
				await this.cipher.seal(
					["slack-session", digest, kind].join("\n"),
					payload,
				),
			],
		);
		return token;
	}
	async authenticate(
		token: string,
		kind: SessionKind,
		consume = false,
	): Promise<Session | null> {
		if (!/^[a-f0-9]{64}$/u.test(token)) return null;
		const digest = await hash(token);
		const query = consume
			? "DELETE FROM api_slack_sessions WHERE token_hash = $1 AND kind = $2 AND expires_at > $3 RETURNING team_id, owner_id, generation, payload"
			: "SELECT team_id, owner_id, generation, payload FROM api_slack_sessions WHERE token_hash = $1 AND kind = $2 AND expires_at > $3";
		const row = (
			await this.db.query<Session>(query, [digest, kind, Date.now()])
		)[0];
		return row
			? {
					...row,
					payload: await this.cipher.open(
						["slack-session", digest, kind].join("\n"),
						row.payload,
					),
				}
			: null;
	}
}
