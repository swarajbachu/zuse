const { withGradleProperties } = require("@expo/config-plugins");

const PROPERTY = "reactNativeArchitectures";
const ARCHITECTURES = "arm64-v8a,x86_64";

/**
 * Keep the generated application ABI set aligned with the native Ghostty
 * terminal module. Allowing Expo to generate a 32-bit APK would produce an
 * installable app whose terminal view cannot load its JNI library.
 */
module.exports = function withAndroidArchitectures(config) {
	return withGradleProperties(config, (mod) => {
		mod.modResults = mod.modResults.filter(
			(item) => item.type !== "property" || item.key !== PROPERTY,
		);
		mod.modResults.push({
			type: "property",
			key: PROPERTY,
			value: ARCHITECTURES,
		});
		return mod;
	});
};

module.exports.ARCHITECTURES = ARCHITECTURES;
