/**
 * Canonical public origins for Zuse. These are the only places the desktop,
 * server, docs, and marketing site should derive public URLs from — do not
 * spell out hostnames inline elsewhere.
 *
 *   - `ZUSE_WEB_ORIGIN`  — marketing site + static assets (`/models`, `/schemas`)
 *   - `ZUSE_DOCS_ORIGIN` — documentation site
 *   - `ZUSE_API_ORIGIN`  — hosted control plane (see ADR 0003)
 */
export const ZUSE_WEB_ORIGIN = "https://zuse.sh";
export const ZUSE_DOCS_ORIGIN = "https://docs.zuse.sh";
export const ZUSE_API_ORIGIN = "https://api.zuse.sh";

/** Base URL for the published JSON schemas (settings, keybindings, …). */
export const ZUSE_SCHEMA_BASE_URL = `${ZUSE_WEB_ORIGIN}/schemas`;

/**
 * Published curated model catalog. The file is generated from
 * `BUNDLED_MODEL_CATALOG` by `scripts/generate-model-catalog.ts` and served
 * by the marketing site, so a catalog change ships on merge without a
 * desktop release. Bump the path suffix only on incompatible schema changes.
 */
export const MODEL_CATALOG_PATH = "/models/v1.json";
export const MODEL_CATALOG_URL = `${ZUSE_WEB_ORIGIN}${MODEL_CATALOG_PATH}`;
