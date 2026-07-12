import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

type LegacyFixture = {
	readonly schemaVersion: number;
	readonly projectId: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly messageId: string;
	readonly title: string;
	readonly message: string;
	readonly createdAt: string;
	readonly messageAt: string;
};

const fixturePath = fileURLToPath(
	new URL("../fixtures/legacy-v29.json", import.meta.url),
);
const schemaPath = fileURLToPath(
	new URL("../fixtures/legacy-v29.sql", import.meta.url),
);

export const legacyFixture = JSON.parse(
	readFileSync(fixturePath, "utf8"),
) as LegacyFixture;

export const createLegacyDatabase = async (
	filename: string,
	repository: string,
): Promise<void> => {
	mkdirSync(dirname(filename), { recursive: true });
	const database = new DatabaseSync(filename);
	try {
		database.exec(readFileSync(schemaPath, "utf8"));
		database
			.prepare(
				"INSERT INTO projects (id, path, name, created_at, updated_at) VALUES (?, ?, 'Legacy project', ?, ?)",
			)
			.run(
				legacyFixture.projectId,
				repository,
				legacyFixture.createdAt,
				legacyFixture.messageAt,
			);
		database
			.prepare(
				`INSERT INTO chats
				 (id, project_id, title, last_message_at, last_read_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				legacyFixture.chatId,
				legacyFixture.projectId,
				legacyFixture.title,
				legacyFixture.messageAt,
				legacyFixture.createdAt,
				legacyFixture.createdAt,
				legacyFixture.messageAt,
			);
		database
			.prepare(
				`INSERT INTO sessions
				 (id, project_id, title, provider_id, model, status, resume_strategy,
				  runtime_mode, chat_id, permission_mode, tool_search, queue_paused,
				  created_at, updated_at)
				 VALUES (?, ?, ?, 'gemini', 'deterministic-model', 'idle', 'none',
				  'approval-required', ?, 'default', 0, 0, ?, ?)`,
			)
			.run(
				legacyFixture.sessionId,
				legacyFixture.projectId,
				legacyFixture.title,
				legacyFixture.chatId,
				legacyFixture.createdAt,
				legacyFixture.messageAt,
			);
		database
			.prepare(
				`INSERT INTO messages
				 (id, session_id, role, kind, content_json, created_at)
				 VALUES (?, ?, 'user', 'user', ?, ?)`,
			)
			.run(
				legacyFixture.messageId,
				legacyFixture.sessionId,
				JSON.stringify({
					_tag: "user",
					text: legacyFixture.message,
					goal: false,
				}),
				legacyFixture.messageAt,
			);
		database
			.prepare("UPDATE chats SET active_session_id = ? WHERE id = ?")
			.run(legacyFixture.sessionId, legacyFixture.chatId);
	} finally {
		database.close();
	}
};
