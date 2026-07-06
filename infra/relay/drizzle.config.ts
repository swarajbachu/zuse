import { defineConfig } from "drizzle-kit";

/** PlanetScale URLs use `sslrootcert=system` (psql-only); strip it for node pg. */
const databaseUrl = (): string => {
  const raw = process.env.DATABASE_URL;
  if (raw === undefined || raw === "") {
    throw new Error("DATABASE_URL is required (set in infra/relay/.env)");
  }
  const url = new URL(raw);
  url.searchParams.delete("sslrootcert");
  return url.toString();
};

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl(),
    ssl: true,
  },
});
