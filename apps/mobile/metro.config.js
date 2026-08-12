const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const path = require("node:path");
const {
	getPaidIconAliases,
	resolveIconMode,
} = require("../../scripts/icon-runtime.cjs");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
const iconAliases =
	resolveIconMode() === "paid" ? getPaidIconAliases() : Object.create(null);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(monorepoRoot, "node_modules"),
];
config.resolver.extraNodeModules = {
	react: path.resolve(projectRoot, "node_modules/react"),
	"react-native": path.resolve(projectRoot, "node_modules/react-native"),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
	const paidIconModule = iconAliases[moduleName];
	if (paidIconModule) {
		return context.resolveRequest(context, paidIconModule, platform);
	}

	const isNobleCryptoCompatibilityImport =
		moduleName === "@noble/hashes/crypto" ||
		moduleName === "@noble/hashes/crypto.js" ||
		moduleName.endsWith(
			`${path.sep}@noble${path.sep}hashes${path.sep}crypto.js`,
		) ||
		(moduleName === "./crypto.js" &&
			context.originModulePath.includes(
				`${path.sep}@noble${path.sep}hashes${path.sep}`,
			));

	if (isNobleCryptoCompatibilityImport) {
		return context.resolveRequest(
			{ ...context, unstable_enablePackageExports: false },
			moduleName,
			platform,
		);
	}

	if (defaultResolveRequest) {
		return defaultResolveRequest(context, moduleName, platform);
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = withUniwindConfig(config, {
	cssEntryFile: "./global.css",
	dtsFile: "./src/uniwind-types.d.ts",
});
