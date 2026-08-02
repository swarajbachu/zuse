export const SURFACES = [
	"desktop",
	"local-browser",
	"hosted-browser",
	"mobile",
	"serve",
] as const;

export type Surface = (typeof SURFACES)[number];

export type FeatureSupport = {
	readonly title: string;
	readonly description: string;
	readonly surfaces: Partial<Record<Surface, "supported" | "partial" | "host">>;
};

export const FEATURES = {
	chat: {
		title: "Agent conversations",
		description:
			"Create, resume, stream, steer, and interrupt coding-agent sessions.",
		surfaces: {
			desktop: "supported",
			"local-browser": "supported",
			"hosted-browser": "supported",
			mobile: "supported",
			serve: "host",
		},
	},
	files: {
		title: "Files and diffs",
		description:
			"Browse project files and review changes from the active workspace.",
		surfaces: {
			desktop: "supported",
			"local-browser": "supported",
			"hosted-browser": "supported",
			mobile: "supported",
			serve: "host",
		},
	},
	terminal: {
		title: "Terminal",
		description: "Run commands on the computer that owns the workspace.",
		surfaces: {
			desktop: "supported",
			"local-browser": "supported",
			"hosted-browser": "supported",
			mobile: "partial",
			serve: "host",
		},
	},
	approvals: {
		title: "Approvals and questions",
		description:
			"Review permission requests, questions, and plans from any connected client.",
		surfaces: {
			desktop: "supported",
			"local-browser": "supported",
			"hosted-browser": "supported",
			mobile: "supported",
			serve: "host",
		},
	},
} satisfies Record<string, FeatureSupport>;
