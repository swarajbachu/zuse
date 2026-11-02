import type { ProviderId } from "@zuse/contracts";
import type { ImageSourcePropType } from "react-native";

export const PROVIDER_LOGOS: Partial<Record<ProviderId, ImageSourcePropType>> =
	{
		zuse: require("../../assets/icon.png"),
		claude: require("../../assets/providers/claude.png"),
		codex: require("../../assets/providers/codex.png"),
		cursor: require("../../assets/providers/cursor.png"),
		gemini: require("../../assets/providers/gemini.png"),
		grok: require("../../assets/providers/grok.png"),
		opencode: require("../../assets/providers/opencode.png"),
		pi: require("../../assets/providers/pi.png"),
		opencode2: require("../../assets/providers/opencode.png"),
		kiro: require("../../assets/providers/kiro.png"),
	};

/** Matching image-set names bundled in the native iOS asset catalog. */
export const PROVIDER_NATIVE_ASSET_NAMES: Partial<Record<ProviderId, string>> =
	{
		zuse: "AppIcon",
		claude: "provider-claude",
		codex: "provider-codex",
		cursor: "provider-cursor",
		gemini: "provider-gemini",
		grok: "provider-grok",
		opencode: "provider-opencode",
		opencode2: "provider-opencode",
		kiro: "provider-kiro",
		pi: "provider-pi",
	};
