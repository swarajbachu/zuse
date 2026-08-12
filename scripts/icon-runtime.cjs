const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const workspaceRoot = resolve(__dirname, "..");
const defaultPaidIconsDir = join(workspaceRoot, "vendor", "paid-icons");

const PAID_ICON_MODULES = Object.freeze({
	"@zuse/icons/bulk-rounded": "@hugeicons-pro/core-bulk-rounded",
	"@zuse/icons/solid-rounded": "@hugeicons-pro/core-solid-rounded",
	"@zuse/icons/stroke-rounded": "@hugeicons-pro/core-stroke-rounded",
});
const PAID_ICON_PACKAGES = Object.freeze(Object.values(PAID_ICON_MODULES));

const packageDirectory = (paidIconsDir, packageName) =>
	join(paidIconsDir, "node_modules", ...packageName.split("/"));

const packageManifestPath = (paidIconsDir, packageName) =>
	join(packageDirectory(paidIconsDir, packageName), "package.json");

const installedPaidPackages = (paidIconsDir) =>
	PAID_ICON_PACKAGES.filter((packageName) =>
		existsSync(packageManifestPath(paidIconsDir, packageName)),
	);

const detectIconMode = ({ paidIconsDir = defaultPaidIconsDir } = {}) => {
	const installed = installedPaidPackages(paidIconsDir);
	if (installed.length === 0) return "free";
	if (installed.length === PAID_ICON_PACKAGES.length) return "paid";

	const missing = PAID_ICON_PACKAGES.filter(
		(packageName) => !installed.includes(packageName),
	);
	throw new Error(
		`Incomplete paid icon installation. Missing: ${missing.join(", ")}. Run bun run icons:install-paid again.`,
	);
};

const resolveIconMode = ({
	paidIconsDir = defaultPaidIconsDir,
	requestedMode = process.env.ZUSE_ICON_MODE?.trim() || "auto",
} = {}) => {
	if (requestedMode === "free") return "free";
	const detectedMode = detectIconMode({ paidIconsDir });
	if (requestedMode === "paid" && detectedMode !== "paid") {
		throw new Error(
			"Paid icons were requested but are not installed. Export HUGEICONS_TOKEN and run bun run icons:install-paid.",
		);
	}
	if (requestedMode !== "auto" && requestedMode !== "paid") {
		throw new Error(
			`Invalid ZUSE_ICON_MODE value ${JSON.stringify(requestedMode)}. Expected auto, free, or paid.`,
		);
	}
	return detectedMode;
};

const getPaidIconAliases = ({ paidIconsDir = defaultPaidIconsDir } = {}) => {
	if (detectIconMode({ paidIconsDir }) !== "paid") return {};

	return Object.fromEntries(
		Object.entries(PAID_ICON_MODULES).map(([facadeName, packageName]) => {
			const packageDir = packageDirectory(paidIconsDir, packageName);
			const manifest = JSON.parse(
				readFileSync(join(packageDir, "package.json"), "utf8"),
			);
			const modulePath = manifest.module;
			if (typeof modulePath !== "string" || modulePath.length === 0) {
				throw new Error(
					`${packageName} does not declare an ESM module entrypoint.`,
				);
			}
			return [facadeName, resolve(packageDir, modulePath)];
		}),
	);
};

module.exports = {
	defaultPaidIconsDir,
	detectIconMode,
	getPaidIconAliases,
	PAID_ICON_MODULES,
	PAID_ICON_PACKAGES,
	resolveIconMode,
};
