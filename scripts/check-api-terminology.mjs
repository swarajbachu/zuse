import { spawnSync } from "node:child_process";

const historicalPaths = [
	/^infra\/api\/drizzle\/migrations\/(?:000\d|001[0-5])_/u,
	/^infra\/api\/drizzle\/migrations\/meta\//u,
	/^apps\/server\/src\/persistence\/migrations\/002[4-8]_/u,
	/^apps\/server\/src\/persistence\/migrations\/0052_api_config\.ts$/u,
	/^docs\/adr\/000[12]-/u,
	/^docs\/adr\/0003-api-control-plane-naming\.md$/u,
	/^infra\/api\/drizzle\/migrations\/0016_api_naming\.sql$/u,
	/^infra\/api\/test\/unit\/migration-safety\.test\.ts$/u,
	/^apps\/server\/test\/integration\/api-config-migration\.test\.ts$/u,
	/^apps\/server\/test\/integration\/(?:lan-auth-service|ws-auth)\.test\.ts$/u,
	/^apps\/mobile\/(?:src|test\/unit)\/lib\/connection-records(?:\.test)?\.ts$/u,
	/^CHANGELOG\.md$/u,
	/^apps\/web\/content\/changelog\.json$/u,
	/^scripts\/check-api-terminology\.mjs$/u,
];

const isHistorical = (path) =>
	historicalPaths.some((pattern) => pattern.test(path));
const forbiddenTerm =
	/\b(?:relay(?=[^a-z]|[A-Z])|Relay(?=[^a-z]|[A-Z])|RELAY(?=[^A-Z]|$))/u;
const removeInfrastructureExceptions = (value) =>
	value
		.replaceAll("RELAY_MINT_PRIVATE_JWK", "")
		.replaceAll("zuse-relay-staging", "")
		.replaceAll("zuse-relay", "");

const grep = spawnSync("git", ["grep", "-n", "-I", "-E", "relay|Relay|RELAY"], {
	encoding: "utf8",
});
if (grep.error !== undefined) throw grep.error;
if (grep.status !== 0 && grep.status !== 1) {
	process.stderr.write(grep.stderr);
	process.exit(grep.status ?? 1);
}

const violations = grep.stdout
	.split("\n")
	.filter(Boolean)
	.filter((line) => {
		const separator = line.indexOf(":");
		const path = separator === -1 ? line : line.slice(0, separator);
		return (
			!isHistorical(path) &&
			forbiddenTerm.test(
				removeInfrastructureExceptions(line.slice(separator + 1)),
			)
		);
	});

const paths = spawnSync("git", ["ls-files"], { encoding: "utf8" });
if (paths.error !== undefined) throw paths.error;
if (paths.status !== 0) process.exit(paths.status ?? 1);
for (const path of paths.stdout.split("\n").filter(Boolean)) {
	if (
		!isHistorical(path) &&
		forbiddenTerm.test(removeInfrastructureExceptions(path))
	)
		violations.push(`${path}: forbidden API-era filename`);
}

if (violations.length > 0) {
	console.error(
		"Relay terminology is restricted to immutable history and infrastructure identifiers:",
	);
	for (const violation of violations) console.error(`- ${violation}`);
	process.exit(1);
}
