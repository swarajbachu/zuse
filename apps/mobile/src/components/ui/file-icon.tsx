import { memo } from "react";
import { SvgXml } from "react-native-svg";
import { useUniwind } from "uniwind";

import { FILE_ICON_XML } from "~/lib/icons/file-icons.generated";
import { resolveFileIconToken } from "~/lib/icons/resolve";

const LIGHT_TONES: Readonly<Record<string, string>> = {
	gray: "#6c6c71",
	red: "#d52c36",
	vermilion: "#d5512f",
	orange: "#d47628",
	yellow: "#d5a910",
	green: "#199f43",
	teal: "#17a5af",
	cyan: "#1ca1c7",
	blue: "#1a85d4",
	indigo: "#693acf",
	purple: "#a631be",
	pink: "#d32a61",
	mauve: "#594c5b",
};

const DARK_TONES: Readonly<Record<string, string>> = {
	gray: "#adadb1",
	red: "#ff6762",
	vermilion: "#ff8c5b",
	orange: "#ffa359",
	yellow: "#ffd452",
	green: "#5ecc71",
	teal: "#64d1db",
	cyan: "#68cdf2",
	blue: "#69b1ff",
	indigo: "#9d6afb",
	purple: "#d568ea",
	pink: "#ff678d",
	mauve: "#79697b",
};

const TOKEN_TONES: Readonly<Record<string, string>> = {
	astro: "purple",
	babel: "yellow",
	bash: "green",
	biome: "blue",
	bootstrap: "indigo",
	browserslist: "yellow",
	bun: "mauve",
	c: "blue",
	claude: "orange",
	cpp: "blue",
	css: "indigo",
	database: "purple",
	docker: "blue",
	eslint: "indigo",
	git: "vermilion",
	go: "cyan",
	graphql: "pink",
	html: "orange",
	image: "pink",
	javascript: "yellow",
	json: "orange",
	markdown: "green",
	mcp: "teal",
	nextjs: "gray",
	npm: "red",
	oxc: "cyan",
	postcss: "red",
	prettier: "teal",
	python: "blue",
	react: "cyan",
	ruby: "red",
	rust: "orange",
	sass: "pink",
	stylelint: "indigo",
	svelte: "red",
	svg: "orange",
	svgo: "green",
	swift: "orange",
	table: "green",
	tailwind: "cyan",
	terraform: "indigo",
	text: "gray",
	typescript: "blue",
	vite: "purple",
	vscode: "blue",
	vue: "green",
	wasm: "indigo",
	webpack: "blue",
	yml: "red",
	zig: "orange",
	zip: "yellow",
};

export const FileIcon = memo(function FileIcon({
	path,
	size = 14,
}: {
	path: string;
	size?: number;
}) {
	const { theme } = useUniwind();
	const token = resolveFileIconToken(path);
	const xml = FILE_ICON_XML[token] ?? FILE_ICON_XML.default;
	if (xml === undefined) return null;
	const tones = theme === "dark" ? DARK_TONES : LIGHT_TONES;
	const color = tones[TOKEN_TONES[token] ?? "gray"] ?? tones.gray;
	return <SvgXml xml={xml} color={color} width={size} height={size} />;
});
