import type { BundledLanguage, ThemeRegistration } from "shiki";

export const DARK_SHIKI_THEME = "zuse-dark" as const;
export const LIGHT_SHIKI_THEME = "zuse-light" as const;

export const SHIKI_THEMES: ReadonlyArray<ThemeRegistration> = [
	{
		name: DARK_SHIKI_THEME,
		type: "dark",
		colors: {
			"editor.background": "#00000000",
			"editor.foreground": "#e4e4e7",
			"editorLineNumber.foreground": "#71717a",
			"editor.selectionBackground": "#a855f72e",
		},
		tokenColors: [
			{
				scope: ["comment", "punctuation.definition.comment"],
				settings: { foreground: "#71717a", fontStyle: "italic" },
			},
			{
				scope: ["keyword", "storage", "storage.type", "constant.language"],
				settings: { foreground: "#c084fc" },
			},
			{
				scope: ["string", "constant.character", "markup.inline.raw.string"],
				settings: { foreground: "#86efac" },
			},
			{
				scope: ["constant.numeric", "constant.language.boolean"],
				settings: { foreground: "#fbbf24" },
			},
			{
				scope: [
					"entity.name.function",
					"support.function",
					"variable.function",
				],
				settings: { foreground: "#7dd3fc" },
			},
			{
				scope: [
					"entity.name.type",
					"entity.name.class",
					"support.type",
					"support.class",
				],
				settings: { foreground: "#67e8f9" },
			},
			{
				scope: ["entity.other.attribute-name", "variable.parameter"],
				settings: { foreground: "#fda4af" },
			},
			{
				scope: ["entity.name.tag", "support.class.component"],
				settings: { foreground: "#f87171" },
			},
			{
				scope: ["punctuation", "meta.brace", "keyword.operator"],
				settings: { foreground: "#a1a1aa" },
			},
			{
				scope: ["markup.heading", "entity.name.section"],
				settings: { foreground: "#fafafa", fontStyle: "bold" },
			},
			{
				scope: ["markup.link", "string.other.link"],
				settings: { foreground: "#7dd3fc", fontStyle: "underline" },
			},
			{
				scope: ["invalid", "invalid.illegal"],
				settings: { foreground: "#f87171" },
			},
		],
	},
	{
		name: LIGHT_SHIKI_THEME,
		type: "light",
		colors: {
			"editor.background": "#00000000",
			"editor.foreground": "var(--foreground)",
			"editorLineNumber.foreground": "var(--muted-foreground)",
			"editor.selectionBackground":
				"color-mix(in oklab, var(--primary) 22%, transparent)",
		},
		tokenColors: [
			{
				scope: ["comment", "punctuation.definition.comment"],
				settings: {
					foreground: "var(--muted-foreground)",
					fontStyle: "italic",
				},
			},
			{
				scope: ["keyword", "storage", "storage.type", "constant.language"],
				settings: { foreground: "var(--syntax-keyword)" },
			},
			{
				scope: ["string", "constant.character", "markup.inline.raw.string"],
				settings: { foreground: "var(--syntax-string)" },
			},
			{
				scope: ["constant.numeric", "constant.language.boolean"],
				settings: { foreground: "var(--syntax-number)" },
			},
			{
				scope: [
					"entity.name.function",
					"support.function",
					"variable.function",
				],
				settings: { foreground: "var(--syntax-function)" },
			},
			{
				scope: [
					"entity.name.type",
					"entity.name.class",
					"support.type",
					"support.class",
				],
				settings: { foreground: "var(--syntax-type)" },
			},
			{
				scope: ["entity.other.attribute-name", "variable.parameter"],
				settings: { foreground: "var(--syntax-attribute)" },
			},
			{
				scope: ["entity.name.tag", "support.class.component"],
				settings: { foreground: "var(--syntax-tag)" },
			},
			{
				scope: ["punctuation", "meta.brace", "keyword.operator"],
				settings: { foreground: "var(--muted-foreground)" },
			},
			{
				scope: ["markup.heading", "entity.name.section"],
				settings: { foreground: "var(--message-heading)", fontStyle: "bold" },
			},
			{
				scope: ["markup.link", "string.other.link"],
				settings: {
					foreground: "var(--syntax-function)",
					fontStyle: "underline",
				},
			},
			{
				scope: ["invalid", "invalid.illegal"],
				settings: { foreground: "var(--destructive)" },
			},
		],
	},
];

export const SHIKI_LANGUAGES: ReadonlyArray<BundledLanguage> = [
	"ts",
	"tsx",
	"js",
	"jsx",
	"json",
	"md",
	"html",
	"css",
	"python",
	"rust",
	"go",
	"bash",
	"shell",
	"yaml",
	"toml",
	"sql",
];
