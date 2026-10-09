import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import {
	AgentItemId,
	type HtmlRenderReference,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { AttachmentServiceLive } from "../../src/attachment/layers/attachment-service.ts";
import { pinHtmlRenderAttachment } from "../../src/html-render/retention.ts";
import { createHtmlTools } from "../../src/html-render/service.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

it("persists and pins visuals across restart, scopes reads, and releases pins on message deletion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zuse-html-storage-"));
	const makeRuntime = () => {
		const sql = sqliteLayer({ filename: join(dir, "test.sqlite") });
		const database = sql.pipe(
			Layer.provideMerge(MigrationsLive.pipe(Layer.provide(sql))),
		);
		return ManagedRuntime.make(
			AttachmentServiceLive.pipe(
				Layer.provideMerge(database),
				Layer.provide(NodeServices.layer),
				Layer.provide(Layer.succeed(AppPaths, { userData: dir })),
			),
		);
	};
	let runtime = makeRuntime();
	const session = SessionId.make("owner");
	try {
		const service = await runtime.runPromise(AttachmentService);
		const tools = createHtmlTools(service);
		let visual: HtmlRenderReference;
		try {
			visual = await tools.client.render(
				session,
				dir,
				{ html: "<h1>Saved chart</h1>", title: "Chart", height: 400 },
				new AbortController().signal,
			);
		} finally {
			await tools.close();
		}
		const content = {
			_tag: "tool_result" as const,
			itemId: AgentItemId.make("tool"),
			output: { htmlRender: visual },
			isError: false,
		};
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* SqlClient.SqlClient;
				const now = new Date().toISOString();
				yield* db`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('p',${dir},'Project',${now},${now})`;
				yield* db`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('c','p','Chat',${now},${now})`;
				yield* db`INSERT INTO sessions (id,project_id,chat_id,title,provider_id,model,status,created_at,updated_at) VALUES ('owner','p','c','Chat','claude','test','idle',${now},${now})`;
				yield* db`INSERT INTO messages (id,session_id,role,kind,content_json,created_at) VALUES ('m','owner','tool','tool_result',${JSON.stringify(content)},${now})`;
				yield* pinHtmlRenderAttachment(
					db,
					SessionId.make("other"),
					MessageId.make("m"),
					content,
				);
				expect(yield* db`SELECT * FROM message_attachments`).toHaveLength(0);
				yield* pinHtmlRenderAttachment(db, session, MessageId.make("m"), {
					...content,
					isError: true,
				});
				expect(yield* db`SELECT * FROM message_attachments`).toHaveLength(0);
				yield* pinHtmlRenderAttachment(
					db,
					session,
					MessageId.make("m"),
					content,
				);
				yield* pinHtmlRenderAttachment(
					db,
					session,
					MessageId.make("m"),
					content,
				);
				expect(yield* db`SELECT * FROM message_attachments`).toHaveLength(1);
			}),
		);
		await runtime.dispose();
		runtime = makeRuntime();
		await runtime.runPromise(
			Effect.gen(function* () {
				const restored = yield* AttachmentService;
				const attachment = yield* restored.readForSession(
					session,
					visual.attachmentId,
				);
				expect(attachment?.mimeType).toBe("text/html");
				expect(new TextDecoder().decode(attachment?.bytes)).toContain(
					"Saved chart",
				);
				expect(
					yield* restored.readForSession(
						SessionId.make("other"),
						visual.attachmentId,
					),
				).toBeNull();
				const db = yield* SqlClient.SqlClient;
				expect(yield* db`SELECT * FROM message_attachments`).toHaveLength(1);
				yield* db`DELETE FROM messages WHERE id = 'm'`;
				expect(yield* db`SELECT * FROM message_attachments`).toHaveLength(0);
			}),
		);
	} finally {
		await runtime.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
