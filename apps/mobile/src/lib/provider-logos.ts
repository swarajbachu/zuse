import type { ProviderId } from "@zuse/contracts";
import type { ImageSourcePropType } from "react-native";

// Bundled brand logos (template silhouettes — tint at render time). Copied from
// the iOS asset catalog into JS assets so a standard RN <Image> can size and
// align them predictably. Regenerate with the app icons if the marks change.
export const PROVIDER_LOGOS: Record<ProviderId, ImageSourcePropType> = {
	claude: require("../../assets/providers/claude.png"),
	codex: require("../../assets/providers/codex.png"),
	cursor: require("../../assets/providers/cursor.png"),
	gemini: require("../../assets/providers/gemini.png"),
	grok: require("../../assets/providers/grok.png"),
	opencode: require("../../assets/providers/opencode.png"),
};
