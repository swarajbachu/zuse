import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { Copy, Image as ImageIcon } from "lucide-react-native";
import { memo, useState } from "react";
import {
	Alert,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import MarkdownDisplay, {
	type ASTNode,
	type RenderRules,
} from "react-native-markdown-display";
import { useUniwind } from "uniwind";
import { colors } from "~/theme";
import MermaidDiagram from "./mermaid-diagram";

const SANS = "Inter_400Regular";
const SANS_MEDIUM = "Inter_600SemiBold";
const MONO = "GeistMono_400Regular";

const markdownStyles = StyleSheet.create({
	body: {
		color: colors.fg,
		fontFamily: SANS,
		fontSize: 15,
		lineHeight: 22,
	},
	heading1: {
		fontFamily: SANS_MEDIUM,
		fontSize: 22,
		lineHeight: 28,
		marginBottom: 6,
		marginTop: 8,
	},
	heading2: {
		fontFamily: SANS_MEDIUM,
		fontSize: 19,
		lineHeight: 25,
		marginBottom: 6,
		marginTop: 8,
	},
	heading3: {
		fontFamily: SANS_MEDIUM,
		fontSize: 17,
		lineHeight: 23,
		marginBottom: 4,
		marginTop: 6,
	},
	heading4: {
		fontFamily: SANS_MEDIUM,
		fontSize: 15,
		lineHeight: 21,
		marginBottom: 4,
		marginTop: 6,
	},
	heading5: { fontFamily: SANS_MEDIUM, fontSize: 14, lineHeight: 20 },
	heading6: {
		fontFamily: SANS_MEDIUM,
		fontSize: 13,
		lineHeight: 19,
		color: colors.mutedFg,
	},
	strong: { fontFamily: SANS_MEDIUM },
	em: { fontStyle: "italic" },
	link: { color: colors.accent, textDecorationLine: "underline" },
	blockquote: {
		backgroundColor: colors.card,
		borderColor: colors.border,
		borderLeftWidth: 3,
		borderRadius: 6,
		marginVertical: 4,
		paddingHorizontal: 10,
		paddingVertical: 4,
	},
	hr: {
		backgroundColor: colors.border,
		height: StyleSheet.hairlineWidth,
		marginVertical: 8,
	},
	bullet_list: { marginVertical: 2 },
	ordered_list: { marginVertical: 2 },
	code_inline: {
		backgroundColor: colors.card,
		borderRadius: 4,
		color: colors.fg,
		fontFamily: MONO,
		fontSize: 13,
		paddingHorizontal: 4,
		paddingVertical: 1,
	},
	code_block: {
		color: colors.fg,
		fontFamily: MONO,
		fontSize: 13,
		lineHeight: 19,
	},
	fence: {
		color: colors.fg,
		fontFamily: MONO,
		fontSize: 13,
		lineHeight: 19,
	},
	table: {
		borderColor: colors.border,
		borderRadius: 6,
		borderWidth: StyleSheet.hairlineWidth,
		marginVertical: 4,
	},
	th: { fontFamily: SANS_MEDIUM, padding: 6 },
	td: { borderColor: colors.border, padding: 6 },
	tr: { borderColor: colors.border },
});

const trimTrailingNewline = (value: string): string =>
	value.endsWith("\n") ? value.slice(0, -1) : value;

const languageOf = (node: ASTNode): string => {
	const raw =
		typeof node.attributes.info === "string"
			? node.attributes.info
			: typeof node.attributes.class === "string"
				? node.attributes.class.replace(/^language-/u, "")
				: "";
	return raw.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
};

const CodeBlock = ({ node }: { node: ASTNode }) => {
	const content = trimTrailingNewline(node.content);
	const language = languageOf(node);
	const isMermaid = language === "mermaid";
	return (
		<View
			key={node.key}
			className="my-1 overflow-hidden rounded-xl border border-border bg-card"
		>
			<View className="min-h-11 flex-row items-center border-b border-border px-3">
				<Text className="min-w-0 flex-1 font-mono text-[11px] uppercase text-muted-foreground">
					{isMermaid ? "Mermaid · network disabled" : language || "Code"}
				</Text>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Copy code block"
					hitSlop={8}
					className="h-11 w-11 items-center justify-center"
					onPress={() => void Clipboard.setStringAsync(content)}
				>
					<Copy size={15} color={colors.secondaryFg} />
				</Pressable>
			</View>
			{isMermaid ? (
				<MermaidBlock source={content} />
			) : (
				<ScrollView
					horizontal
					nestedScrollEnabled
					showsHorizontalScrollIndicator
					contentContainerStyle={{ padding: 12 }}
				>
					<Text selectable style={markdownStyles.fence}>
						{content}
					</Text>
				</ScrollView>
			)}
		</View>
	);
};

const MermaidBlock = ({ source }: { source: string }) => {
	const { theme } = useUniwind();
	return (
		<MermaidDiagram
			source={source}
			dark={theme === "dark"}
			dom={{
				allowFileAccess: false,
				allowUniversalAccessFromFileURLs: false,
				javaScriptCanOpenWindowsAutomatically: false,
				mixedContentMode: "never",
				scrollEnabled: true,
				style: { height: 260, width: "100%" },
				unstable_useExpoModulesBridge: false,
			}}
		/>
	);
};

const RemoteMarkdownImage = ({
	source,
	nodeKey,
}: {
	source: string;
	nodeKey: string;
}) => {
	const [loaded, setLoaded] = useState(false);
	if (loaded) {
		return (
			<Image
				key={nodeKey}
				source={{ uri: source }}
				contentFit="contain"
				accessibilityLabel="Remote Markdown image"
				style={{
					width: "100%",
					height: 220,
					borderRadius: 12,
					backgroundColor: colors.card,
				}}
			/>
		);
	}
	return (
		<Pressable
			key={nodeKey}
			accessibilityRole="button"
			accessibilityLabel="Load remote Markdown image"
			onPress={() => setLoaded(true)}
			className="my-1 min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 active:opacity-60"
		>
			<ImageIcon size={18} color={colors.secondaryFg} />
			<View className="min-w-0 flex-1">
				<Text className="font-sans-medium text-[13px] text-foreground">
					Tap to load remote image
				</Text>
				<Text
					numberOfLines={1}
					className="font-sans text-[11px] text-muted-foreground"
				>
					Not loaded automatically for privacy · {source}
				</Text>
			</View>
		</Pressable>
	);
};

const rules: RenderRules = {
	code_block: (node) => <CodeBlock key={node.key} node={node} />,
	fence: (node) => <CodeBlock key={node.key} node={node} />,
	image: (node) => {
		const source =
			typeof node.attributes.src === "string" ? node.attributes.src : "image";
		return (
			<RemoteMarkdownImage key={node.key} nodeKey={node.key} source={source} />
		);
	},
};

const confirmExternalLink = (url: string): boolean => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
	Alert.alert("Open external link?", parsed.toString(), [
		{ text: "Cancel", style: "cancel" },
		{
			text: "Open",
			onPress: () => void Linking.openURL(parsed.toString()),
		},
	]);
	return false;
};

export const Markdown = memo(({ children }: { children: string }) =>
	shouldRenderPlainText(children) ? (
		<Text selectable style={plainTextStyle}>
			{children}
		</Text>
	) : (
		<MarkdownDisplay
			style={markdownStyles}
			rules={rules}
			onLinkPress={confirmExternalLink}
		>
			{children}
		</MarkdownDisplay>
	),
);

Markdown.displayName = "Markdown";

const plainTextStyle = {
	color: colors.fg,
	fontFamily: SANS,
	fontSize: 15,
	lineHeight: 22,
} as const;

const shouldRenderPlainText = (value: string): boolean =>
	value.length > 32_000 || hasLargeHtmlBlock(value) || hasVeryWideTable(value);

const hasLargeHtmlBlock = (value: string): boolean =>
	/<\/?(html|body|script|style|table|details|summary)(\s|>)/iu.test(value);

const hasVeryWideTable = (value: string): boolean => {
	const lines = value.split(/\r\n|\r|\n/u);
	let tableLike = 0;
	for (const line of lines) {
		if ((line.match(/\|/gu)?.length ?? 0) >= 8) {
			tableLike += 1;
			if (tableLike >= 6) return true;
		}
	}
	return false;
};
