import { readFileSync } from "node:fs";
import pg from "pg";
import { zuseSnapshotName } from "../../../packages/sandbox-providers/src/snapshot-name.ts";
import { billingApiBaseUrl } from "../src/cloud-billing-usage-source.ts";

const [command = "report", snapshotName] = process.argv.slice(2);
if (!["report", "cleanup-orphan"].includes(command))
	throw new Error("usage: cloud-snapshot-ops.mjs report | cleanup-orphan NAME");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const primary = new pg.Client({ connectionString: process.env.DATABASE_URL });
const reference = process.env.SNAPSHOT_REFERENCE_DATABASE_URL
	? new pg.Client({
			connectionString: process.env.SNAPSHOT_REFERENCE_DATABASE_URL,
		})
	: null;
const key = process.env.BOAT_API_KEY ?? process.env.BOX_API_KEY;
const base = billingApiBaseUrl(
	process.env.BOAT_API_BASE_URL ?? "https://boat.dev/api/v1",
);
const request = async (path, method = "GET") => {
	if (!key) throw new Error("BOAT_API_KEY is required for provider inventory");
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${key}` },
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Boat request failed (${response.status})`);
	if (method === "DELETE") return;
	return await response.json();
};
const readReferences = async (client) => {
	const builds = (
		await client.query(
			"SELECT build_id, project_id, account_id, provider, snapshot_id, provider_sandbox_id, state, updated_at FROM api_cloud_project_builds WHERE provider = 'box'",
		)
	).rows;
	const workspaces = (
		await client.query(
			"SELECT build_id FROM api_cloud_workspaces WHERE provider = 'box' AND state != 'deleted'",
		)
	).rows;
	return { builds, workspaces };
};
const matches = (build, name) =>
	build.snapshot_id === name ||
	zuseSnapshotName(`${build.project_id}-${build.build_id}`) === name;

try {
	await primary.connect();
	if (reference) await reference.connect();
	if (command === "report") {
		const inventory = (
			await primary.query(
				"SELECT record FROM api_cloud_snapshots ORDER BY account_id, created_at",
			)
		).rows.map((row) => row.record);
		const refs = await readReferences(primary);
		const other = reference ? await readReferences(reference) : null;
		// A captured list can be supplied for read-only offline investigation; cleanup always rechecks Boat.
		const provider = process.env.SNAPSHOT_INVENTORY_FILE
			? JSON.parse(readFileSync(process.env.SNAPSHOT_INVENTORY_FILE, "utf8"))
			: key
				? await request("/named-snapshots")
				: null;
		const unknown = (provider?.snapshots ?? [])
			.filter((s) => !inventory.some((r) => r.snapshotId === s.name))
			.map((s) => ({
				name: s.name,
				status: s.status,
				sourceSandboxId: s.sourceSandboxId,
				candidateBuildIds: refs.builds
					.filter((b) => matches(b, s.name))
					.map((b) => b.build_id),
				referenceEnvironmentBuildIds:
					other?.builds
						.filter((b) => matches(b, s.name))
						.map((b) => b.build_id) ?? [],
				autoDelete: false,
			}));
		console.log(
			JSON.stringify(
				{
					inventory,
					providerInventoryAvailable: provider !== null,
					referenceEnvironmentChecked: other !== null,
					untracked: unknown,
					allowance: provider?.allowance,
				},
				null,
				2,
			),
		);
	} else {
		if (!reference || !snapshotName)
			throw new Error(
				"cleanup-orphan NAME requires SNAPSHOT_REFERENCE_DATABASE_URL for the other environment",
			);
		await primary.query("BEGIN");
		await reference.query("BEGIN");
		for (const client of [primary, reference])
			await client.query("SET LOCAL lock_timeout = '5s'");
		const refs = await readReferences(primary);
		const candidates = refs.builds.filter((b) => matches(b, snapshotName));
		if (candidates.length !== 1)
			throw new Error(
				"Snapshot must have exactly one attributable build; unknown snapshots are preserved",
			);
		const owner = candidates[0];
		// Lock both account lifecycle domains before rechecking every reference and provider identity.
		for (const client of [primary, reference])
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[`snapshot:${owner.account_id}`],
			);
		const fresh = await readReferences(primary);
		const other = await readReferences(reference);
		const current = fresh.builds.find((b) => b.build_id === owner.build_id);
		if (
			!current ||
			current.snapshot_id ||
			["queued", "building", "sanitizing"].includes(current.state) ||
			fresh.workspaces.some((w) => w.build_id === owner.build_id)
		)
			throw new Error(
				"Snapshot still has a build/workspace reference or in-flight publication",
			);
		const replacement = fresh.builds.some(
			(build) =>
				build.account_id === owner.account_id &&
				build.build_id !== owner.build_id &&
				build.state === "ready" &&
				build.snapshot_id &&
				Number(build.updated_at) > Number(current.updated_at),
		);
		if (current.state !== "failed" && !replacement)
			throw new Error(
				"Only a failed build or a verified superseded image may be removed",
			);
		if (
			other.builds.some((b) => matches(b, snapshotName)) ||
			other.workspaces.some((w) => w.build_id === owner.build_id)
		)
			throw new Error("Snapshot is referenced by the other environment");
		const tracked = (
			await primary.query(
				"SELECT state FROM api_cloud_snapshots WHERE provider='box' AND snapshot_id=$1",
				[snapshotName],
			)
		).rows[0];
		if (tracked && tracked.state !== "deleted")
			throw new Error("Tracked snapshots must use the durable reconciler");
		const info = await request(
			`/named-snapshots/${encodeURIComponent(snapshotName)}`,
		);
		const observed = (
			await primary.query(
				"SELECT provider_sandbox_id FROM api_cloud_runtime_observations WHERE provider='box' AND observation->>'accountId'=$1 AND observation->>'resourceKind'='build' AND observation->>'resourceId'=$2",
				[owner.account_id, owner.build_id],
			)
		).rows.map((row) => row.provider_sandbox_id);
		const sourceIds = [current.provider_sandbox_id, ...observed].filter(
			Boolean,
		);
		if (
			info !== null &&
			(info.snapshot.name !== snapshotName ||
				info.snapshot.status === "saving" ||
				!sourceIds.includes(info.snapshot.sourceSandboxId))
		)
			throw new Error(
				"Exact provider source ownership could not be verified; preserve the snapshot",
			);
		await request(
			`/named-snapshots/${encodeURIComponent(snapshotName)}`,
			"DELETE",
		);
		const nowMs = Date.now();
		const record = {
			snapshotId: snapshotName,
			provider: "box",
			accountId: owner.account_id,
			buildId: owner.build_id,
			state: "deleted",
			createdAtMs: nowMs,
			deletedAtMs: nowMs,
			remainder: 0,
			attempts: 0,
			nextAttemptAtMs: nowMs,
		};
		await primary.query(
			"INSERT INTO api_cloud_snapshots(provider,snapshot_id,account_id,build_id,state,created_at,record) VALUES ('box',$1,$2,$3,'deleted',$4,$5) ON CONFLICT DO NOTHING",
			[
				snapshotName,
				owner.account_id,
				owner.build_id,
				nowMs,
				JSON.stringify(record),
			],
		);
		await primary.query("COMMIT");
		await reference.query("COMMIT");
		console.log(
			JSON.stringify({
				deleted: true,
				snapshotName,
				accountId: owner.account_id,
				buildId: owner.build_id,
			}),
		);
	}
} catch (error) {
	for (const client of [primary, reference]) {
		if (client) await client.query("ROLLBACK").catch(() => {});
	}
	throw error;
} finally {
	await primary.end();
	if (reference) await reference.end();
}
