import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Records the absolute on-disk path of each attachment blob.
 *
 * Blobs used to live in a single flat `{userData}/attachments/` directory, so
 * the path could be reconstructed from the id + extension. They now live in
 * the workspace's per-session `.context/files/` directory, whose location
 * depends on the session's cwd — so we persist the resolved absolute path and
 * read it back directly. Existing rows keep `abs_path` NULL; readers fall back
 * to the legacy flat-dir layout for those, so pre-migration blobs still
 * resolve.
 */
export const Migration0022AttachmentAbsPath = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE attachments ADD COLUMN abs_path TEXT
  `;
});
