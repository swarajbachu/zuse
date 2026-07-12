import { verifyBackfillDatabase } from "../apps/server/src/persistence/backfill-verifier.ts";

const main = async (): Promise<void> => {
  const databases = process.argv.slice(2);
  if (databases.length === 0) {
    throw new Error("usage: bun run verify:backfill -- <database-copy> [...]");
  }
  for (const database of databases) await verifyBackfillDatabase(database);
};

void main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
