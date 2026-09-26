const APP_VARIANTS = new Set(["development", "testflight", "production"]);

const resolveVariant = () => {
	const variant = process.env.APP_VARIANT ?? "production";
	if (!APP_VARIANTS.has(variant)) {
		throw new Error(
			`Unsupported APP_VARIANT "${variant}". Expected development, testflight, or production.`,
		);
	}
	return variant;
};

module.exports = ({ config }) => {
	const variant = resolveVariant();
	const development = variant === "development";
	const scheme = development ? "zuse-dev" : "zuse";
	const bundleIdentifier = development ? "com.zuse.sh.dev" : "com.zuse.sh";

	return {
		...config,
		name: development ? "Zuse Dev" : "Zuse",
		scheme,
		ios: {
			...config.ios,
			bundleIdentifier,
			entitlements: {
				...config.ios?.entitlements,
				"aps-environment": development ? "development" : "production",
				"keychain-access-groups": [
					development
						? "$(AppIdentifierPrefix)com.zuse.sh.dev"
						: "$(AppIdentifierPrefix)com.zuse.shared-connectivity",
				],
			},
		},
		plugins: config.plugins.map((plugin) =>
			plugin === "expo-dev-client"
				? ["expo-dev-client", { addGeneratedScheme: development }]
				: plugin,
		),
		extra: {
			...config.extra,
			appVariant: variant,
			releaseChannel: variant,
		},
	};
};
