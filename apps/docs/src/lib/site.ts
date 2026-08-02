export const SITE = {
	name: "Zuse Docs",
	description:
		"Guides and reference for Zuse desktop, mobile, remote access, and Serve.",
	url: "https://docs.zuse.sh",
	productUrl: "https://zuse.dev",
	downloadUrl: "https://zuse.dev/download",
	githubUrl: "https://github.com/swarajbachu/zuse",
} as const;

export const SECTION_LABELS: Record<string, string> = {
	start: "Start here",
	concepts: "Core concepts",
	desktop: "Desktop",
	providers: "Providers",
	projects: "Projects & worktrees",
	composer: "Composer & agents",
	workspace: "Workspace tools",
	remote: "Remote access",
	mobile: "Mobile",
	serve: "Serve CLI",
	reference: "Reference",
};
