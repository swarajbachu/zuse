import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Durable identity and authorization for shared host workspaces.
 * OIDC credentials are intentionally not stored here: the identity boundary
 * resolves an immutable subject. WorkOS-backed membership is a projection;
 * these tables own local membership and private workspace grants.
 */
export const Migration0065SharedHostAccess = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	yield* sql`
		CREATE TABLE IF NOT EXISTS collaboration_teams (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			organization_id TEXT UNIQUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;

	yield* sql`
		CREATE TABLE IF NOT EXISTS collaboration_members (
			id TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES collaboration_teams(id) ON DELETE CASCADE,
			subject TEXT NOT NULL,
			organization_membership_id TEXT,
			email TEXT NOT NULL,
			display_name TEXT NOT NULL,
			avatar_url TEXT,
			role TEXT NOT NULL CHECK (role IN ('owner', 'driver', 'viewer')),
			status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
			joined_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (team_id, subject),
			UNIQUE (id, team_id)
		)
	`;

	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_collaboration_members_team_status
		ON collaboration_members(team_id, status)
	`;

	yield* sql`
		CREATE TABLE IF NOT EXISTS collaboration_invites (
			id TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES collaboration_teams(id) ON DELETE CASCADE,
			token_hash TEXT NOT NULL UNIQUE,
			email TEXT,
			role TEXT NOT NULL CHECK (role IN ('driver', 'viewer')),
			status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
			created_by_member_id TEXT NOT NULL REFERENCES collaboration_members(id),
			expires_at TEXT NOT NULL,
			accepted_by_member_id TEXT REFERENCES collaboration_members(id),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;

	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_collaboration_invites_team_status
		ON collaboration_invites(team_id, status, expires_at)
	`;

	yield* sql`
		CREATE TABLE IF NOT EXISTS collaboration_workspaces (
			chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
			team_id TEXT NOT NULL REFERENCES collaboration_teams(id) ON DELETE CASCADE,
			UNIQUE (chat_id, team_id)
		)
	`;

	yield* sql`
		CREATE TABLE IF NOT EXISTS collaboration_chat_grants (
			team_id TEXT NOT NULL REFERENCES collaboration_teams(id) ON DELETE CASCADE,
			chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
			member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
			role TEXT NOT NULL CHECK (role IN ('owner', 'driver', 'viewer')),
			granted_by_member_id TEXT NOT NULL REFERENCES collaboration_members(id),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (chat_id, member_id),
			FOREIGN KEY (chat_id, team_id) REFERENCES collaboration_workspaces(chat_id, team_id) ON DELETE CASCADE,
			FOREIGN KEY (member_id, team_id) REFERENCES collaboration_members(id, team_id) ON DELETE CASCADE,
			FOREIGN KEY (granted_by_member_id, team_id) REFERENCES collaboration_members(id, team_id)
		)
	`;

	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_collaboration_chat_grants_member
		ON collaboration_chat_grants(member_id, chat_id)
	`;

	yield* sql`
		CREATE TABLE IF NOT EXISTS collaboration_audit_events (
			id TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES collaboration_teams(id) ON DELETE CASCADE,
			actor_member_id TEXT REFERENCES collaboration_members(id),
			action TEXT NOT NULL,
			resource_kind TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			metadata_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`;

	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_collaboration_audit_team_created
		ON collaboration_audit_events(team_id, created_at DESC)
	`;
});
