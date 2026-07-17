import {
	createFileTreeIconResolver,
	getBuiltInSpriteSheet,
} from "@pierre/trees";
import { useInsertionEffect } from "react";
import { getFolderIconUrl } from "../lib/icons/material-icons.ts";

type Props = {
	readonly name: string;
	readonly kind: "file" | "directory";
	readonly expanded?: boolean;
	readonly className?: string;
};

export type ResolvedFileIcon = {
	readonly name: string;
	readonly token?: string;
	readonly viewBox?: string;
};

const FILE_ICON_SPRITE_ID = "fz-file-icon-sprite";
const fileIconResolver = createFileTreeIconResolver("complete");
const fileIconSprite = getBuiltInSpriteSheet("complete");

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

const installFileIconSprite = () => {
	if (
		typeof document === "undefined" ||
		document.getElementById(FILE_ICON_SPRITE_ID) !== null
	) {
		return;
	}
	const sprite = document.createElement("div");
	sprite.id = FILE_ICON_SPRITE_ID;
	sprite.setAttribute("aria-hidden", "true");
	sprite.style.display = "none";
	sprite.innerHTML = fileIconSprite;
	document.body.prepend(sprite);
};

export const resolveFileIcon = (name: string): ResolvedFileIcon =>
	fileIconResolver.resolveIcon("file-tree-icon-file", name);

/** Uses the same file-type resolver and glyph set as the structured file tree. */
export function FileIcon({ name, kind, expanded = false, className }: Props) {
	useInsertionEffect(installFileIconSprite, []);

	const wrapperClass =
		className ?? "inline-flex size-3.5 shrink-0 items-center justify-center";
	if (kind === "directory") {
		const url = getFolderIconUrl(name, expanded);
		return (
			<span className={wrapperClass} aria-hidden="true">
				{url ? (
					<img src={url} alt="" className="size-full" draggable={false} />
				) : null}
			</span>
		);
	}

	const icon = resolveFileIcon(name);
	const tone = TOKEN_TONES[icon.token ?? ""] ?? "gray";
	return (
		<span className={wrapperClass} aria-hidden="true">
			<svg
				aria-hidden="true"
				className="size-full"
				viewBox={icon.viewBox ?? "0 0 16 16"}
				data-file-icon-token={icon.token}
				style={{ color: `var(--file-icon-${tone})` }}
			>
				<use href={`#${icon.name}`} />
			</svg>
		</span>
	);
}
