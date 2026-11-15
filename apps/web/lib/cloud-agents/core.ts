import type { AgentRow, Evidence } from "./types";

/**
 * Hand-checked rows. Every value was read from the company's own pricing page,
 * docs, changelog or repository on the check date (see `CHECKED_ON`). Anything
 * the sources did not state is "unknown" and renders as "—".
 *
 * Zuse facts come from the Zuse source tree (swarajbachu/zuse), not marketing copy.
 */

const yes = (src: string, quote?: string): Evidence => ({
	v: "yes",
	src,
	quote,
});
const no = (src: string, quote?: string): Evidence => ({ v: "no", src, quote });
const unknown = (quote?: string): Evidence =>
	quote ? { v: "unknown", quote } : { v: "unknown" };

const ZUSE_GH = "https://github.com/swarajbachu/zuse";
const ZUSE_TREE = `${ZUSE_GH}/blob/main`;

const CODEX_PRICING = "https://learn.chatgpt.com/docs/pricing";
const CODEX_CLOUD = "https://learn.chatgpt.com/docs/cloud";
const CLAUDE_WEB = "https://code.claude.com/docs/en/claude-code-on-the-web";
const CLAUDE_PRICING = "https://claude.com/pricing";
const CURSOR_CLOUD = "https://cursor.com/docs/cloud-agent";
const CURSOR_PRICING = "https://cursor.com/pricing";
const COPILOT_DOCS =
	"https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github";
const COPILOT_3P =
	"https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-third-party-coding-agents";
const COPILOT_PLANS = "https://github.com/features/copilot/plans";
const DEVIN_PRICING = "https://devin.ai/pricing";
const DEVIN_DOCS = "https://docs.devin.ai/get-started/devin-intro";
const AMP_PRICING = "https://ampcode.com/pricing";
const AMP_NEWS = "https://ampcode.com/chronicle";
const JULES_SHUTDOWN = "https://jules.google/docs/changelog/2026-10-29/";
const JULES_CHANGELOG = "https://jules.google/docs/changelog/";
const ANTIGRAVITY = "https://antigravity.google/docs/remote-agents/";
const OH_PRICING = "https://www.openhands.dev/pricing";
const OH_GH = "https://github.com/OpenHands/OpenHands";
const OH_CANVAS =
	"https://docs.openhands.dev/openhands/usage/agent-canvas/overview";
const OH_SETUP =
	"https://docs.openhands.dev/openhands/usage/agent-canvas/setup";
const OH_CLOUD =
	"https://docs.openhands.dev/openhands/usage/cloud/openhands-cloud";
const CAPY_PRICING = "https://capy.ai/pricing";
const CAPY_HOME = "https://capy.ai";
const COND_FAQ = "https://www.conductor.build/docs/cloud/faq";
const COND_CHANGELOG = "https://www.conductor.build/changelog";
const COND_HOME = "https://www.conductor.build";
const FACTORY_PRICING = "https://factory.com/pricing";
const FACTORY_DOCS = "https://docs.factory.ai";
const LEMON = "https://lemonlime.dev/";
const LEMON_GH = "https://github.com/hamedgitty/lemonlime";
const ONA_OPENAI = "https://ona.com/stories/ona-joins-openai";

export const CORE_ROWS: AgentRow[] = [
	{
		id: "zuse",
		name: "Zuse",
		url: "https://www.zuse.sh",
		repoUrl: ZUSE_GH,
		category: "Cloud agent",
		status: "Cloud in public beta",
		description:
			"Open source desktop workspace that runs Claude Code, Codex, Cursor, Grok and other CLI agents side by side, locally or in isolated cloud workspaces.",
		descriptionSource: ZUSE_GH,
		since: "2026-05-08",
		sinceSource: `${ZUSE_GH}/releases/tag/v0.1.0`,
		sinceNote: "First release, v0.1.0",
		pricing: {
			headline: "$40/mo cloud",
			detail:
				"Local app $0 during beta. Cloud Workspace $40/month includes $35 of provider compute; extra compute at provider cost + 5%, with a configurable overage cap ($25 default). Alternatively connect your own boxd, Boat or E2B account and pay that provider directly; no Zuse subscription needed for that compute.",
			src: "https://www.zuse.sh/pricing",
		},
		freeTier: no(
			"https://www.zuse.sh/pricing",
			"Hosted cloud is paid: a Zuse Cloud subscription or your own boxd, Boat or E2B account. The local app is $0 during beta.",
		),
		license: "AGPL-3.0",
		licenseSource: `${ZUSE_TREE}/LICENSE`,
		openSource: yes(
			`${ZUSE_TREE}/LICENSE`,
			"GNU Affero General Public License v3",
		),
		agents: {
			names: [
				"Claude Code",
				"Codex",
				"Cursor",
				"Grok",
				"Kiro",
				"OpenCode",
				"Pi",
			],
			acp: true,
			src: "https://docs.zuse.sh/providers",
			note: "Seven built-in local providers plus ACP agents such as Gemini CLI. Cloud chats sign in to Claude, Codex, Cursor and Grok.",
		},
		integrations: {
			names: ["GitHub", "Slack", "API"],
			src: "https://docs.zuse.sh/how-to/slack-start-task",
		},
		features: {
			cloud: yes(
				"https://docs.zuse.sh/how-to/cloud-start-chat",
				"Cloud chats are in public beta. They work on repositories with a GitHub origin.",
			),
			remote: yes(
				"https://docs.zuse.sh/serve",
				"Zuse Serve turns a Mac or Linux computer into an environment you can open from the hosted web app or Zuse for iPhone.",
			),
			orchestration: yes(
				"https://www.zuse.sh/pricing",
				"Parallel chats and Git worktrees.",
			),
			byo: yes(
				`${ZUSE_TREE}/packages/contracts/src/cloud-auth.ts`,
				"Cloud auth methods: subscription, api-key, custom; providers claude, codex, cursor, grok.",
			),
			mcp: unknown(),
			plugins: unknown(),
		},
		platforms: {
			macos: yes(
				`${ZUSE_TREE}/apps/web/lib/download.ts`,
				"macOS .dmg download",
			),
			windows: no(
				`${ZUSE_TREE}/apps/web/lib/download.ts`,
				"No Windows download target; downloads are macOS and Linux only.",
			),
			linux: yes(
				`${ZUSE_TREE}/apps/web/lib/download.ts`,
				"Linux AppImage and .deb downloads",
			),
			web: yes(
				"https://docs.zuse.sh/serve",
				"Open a Serve computer from the hosted web app.",
			),
			ios: yes("https://docs.zuse.sh/mobile", "Zuse for iPhone"),
			android: unknown(
				"An Expo Android build script exists in the repo; no published Android app is documented.",
			),
		},
		reputation: {
			score: null,
			stars: 250,
			hnStories: 2,
			repo: "swarajbachu/zuse",
			hnQueries: ["github.com/swarajbachu/zuse", "zuse.sh"],
		},
		notes:
			"Hosted cloud only works with GitHub repositories. Only boxd-backed chats can be forked or publish preview URLs. Zuse publishes this page, so check our row as critically as the others.",
		compare: {
			href: "/blog/open-source-cloud-agents",
			label: "Why open source cloud agents",
		},
		verification: "hand",
	},
	{
		id: "openai-codex",
		name: "OpenAI Codex (cloud)",
		url: "https://chatgpt.com/codex",
		repoUrl: "https://github.com/openai/codex",
		category: "Cloud agent",
		description:
			"OpenAI's coding agent. Cloud chats run in OpenAI-hosted containers and share the ChatGPT plan's usage allowance with local Codex.",
		descriptionSource: CODEX_CLOUD,
		since: "2025-05-16",
		sinceSource: "https://openai.com/index/introducing-codex/",
		pricing: {
			headline: "$20/mo (ChatGPT Plus)",
			detail:
				"Cloud chats are listed for Plus ($20/mo), Pro (from $100/mo), Business ($20/user/mo annual, $25 monthly) and Enterprise. Go and Free plans do not list cloud chats; signing in with an API key gives no cloud features.",
			src: CODEX_PRICING,
		},
		freeTier: no(
			CODEX_PRICING,
			"Cloud chats are not listed for the Free or Go plans.",
		),
		license: "Proprietary",
		licenseSource: "https://github.com/openai/codex",
		openSource: no(
			"https://github.com/openai/codex",
			"The cloud service is closed. The Codex CLI is open source under Apache-2.0.",
		),
		agents: { names: ["Codex"], acp: false, src: CODEX_CLOUD },
		integrations: {
			names: ["GitHub", "GitLab", "Slack", "Linear"],
			src: CODEX_CLOUD,
		},
		features: {
			cloud: yes(CODEX_CLOUD, "Cloud chats run in OpenAI-managed containers."),
			remote: unknown(),
			orchestration: unknown(),
			byo: no(
				CODEX_PRICING,
				'API key sign-in: "No cloud-based features (GitHub code review, Slack, etc.)".',
			),
			mcp: unknown(
				"Codex docs cover MCP, but the cloud page does not say MCP servers work in cloud tasks.",
			),
			plugins: unknown(
				"Codex docs cover plugins, but the cloud page does not say plugins work in cloud tasks.",
			),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: yes(
				CODEX_PRICING,
				"Codex on the web, in the CLI, in the IDE extension, and on iOS.",
			),
			ios: yes(
				CODEX_PRICING,
				"Codex on the web, in the CLI, in the IDE extension, and on iOS.",
			),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: 135361,
			hnStories: 66,
			repo: "openai/codex",
		},
		notes:
			"GitLab support is in beta. Stars are for the open source Codex CLI repository.",
		compare: {
			href: "/blog/best-cloud-coding-agents#openai-codex-cloud",
			label: "OpenAI Codex cloud in our roundup",
		},
		verification: "hand",
	},
	{
		id: "claude-code-web",
		name: "Claude Code (cloud sessions)",
		url: "https://claude.ai/code",
		repoUrl: "https://github.com/anthropics/claude-code",
		category: "Cloud agent",
		description:
			"Claude Code sessions that run in an Anthropic-managed VM, started from the web, the Claude apps, or the CLI with --cloud.",
		descriptionSource: CLAUDE_WEB,
		since: "2025-10-20",
		sinceSource: "https://claude.com/resources/articles/claude-code-on-the-web",
		sinceNote: "Research preview; generally available Sep 23, 2026",
		pricing: {
			headline: "$20/mo (Claude Pro)",
			detail:
				"Included with Pro ($20/mo, $17/mo billed annually), Max ($100 or $200/mo), Team and eligible Enterprise seats. No separate charge for the cloud VM; sessions count toward plan usage limits.",
			src: CLAUDE_PRICING,
		},
		freeTier: no(
			CLAUDE_WEB,
			"Available on Pro, Max, Team and Enterprise plans.",
		),
		license: "Proprietary",
		licenseSource: "https://github.com/anthropics/claude-code",
		openSource: no(
			"https://github.com/anthropics/claude-code",
			"The public repository has no open source license.",
		),
		agents: { names: ["Claude Code"], acp: false, src: CLAUDE_WEB },
		integrations: { names: ["GitHub", "Slack", "API"], src: CLAUDE_WEB },
		features: {
			cloud: yes(CLAUDE_WEB, "Sessions run on an Anthropic-managed cloud VM."),
			remote: yes(
				CLAUDE_WEB,
				"Organizations can use a self-hosted environment.",
			),
			orchestration: yes(CLAUDE_WEB, "Run tasks in parallel."),
			byo: no(
				CLAUDE_WEB,
				"Requires claude.ai subscription sign-in; not available through API keys or third-party providers.",
			),
			mcp: yes(CLAUDE_WEB, "Docs cover MCP servers in cloud sessions."),
			plugins: yes(CLAUDE_WEB, "Docs cover plugins in cloud sessions."),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: yes(CLAUDE_WEB, "claude.ai/code"),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: 155744,
			hnStories: 132,
			repo: "anthropics/claude-code",
		},
		notes:
			"Needs GitHub to clone and push; other repos only via an uploaded bundle. Triggers include Slack, schedules, API calls and GitHub events.",
		compare: {
			href: "/blog/run-cloud-coding-agents-on-your-claude-chatgpt-plan",
			label: "Run cloud agents on your Claude or ChatGPT plan",
		},
		verification: "hand",
	},
	{
		id: "cursor-cloud-agents",
		name: "Cursor Cloud Agents",
		url: "https://cursor.com/agents",
		category: "Cloud agent",
		description:
			"Cursor's agent running in isolated cloud machines, started from the editor, web, iOS app, Slack, Linear, GitHub or the API.",
		descriptionSource: CURSOR_CLOUD,
		since: "2025-05-15",
		sinceSource: "https://cursor.com/changelog/0-50",
		sinceNote: "Background Agent preview in Cursor 0.50",
		pricing: {
			headline: "$30/mo (Premium)",
			detail:
				"Needs Premium ($30/mo) or higher, Teams ($30+/user/mo), Enterprise, or a legacy paid plan. Free and Plus do not include them. Usage is billed at the selected model's rate.",
			src: CURSOR_PRICING,
		},
		freeTier: no(CURSOR_CLOUD, "Free and Plus don't include them."),
		license: "Proprietary",
		openSource: no(CURSOR_PRICING, "Closed source commercial product."),
		agents: {
			names: ["Cursor"],
			acp: false,
			src: CURSOR_CLOUD,
			note: "Runs Cursor's agent on a curated selection of models.",
		},
		integrations: {
			names: [
				"GitHub",
				"GitLab",
				"Bitbucket",
				"Azure DevOps",
				"Slack",
				"Microsoft Teams",
				"Linear",
				"API",
			],
			src: CURSOR_CLOUD,
		},
		features: {
			cloud: yes(CURSOR_CLOUD, "Runs in isolated cloud machines."),
			remote: yes(CURSOR_CLOUD, "Self-Hosted Machines."),
			orchestration: yes(
				CURSOR_CLOUD,
				"Run as many agents as you want in parallel.",
			),
			byo: unknown(
				"Pricing lists third-party models at API list price; we found no plan sign-in or key option for cloud agents.",
			),
			mcp: yes(CURSOR_CLOUD, "MCP servers are available to cloud agents."),
			plugins: yes(CURSOR_CLOUD, "Plugins are available to cloud agents."),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: yes(CURSOR_CLOUD, "Start and manage agents from the web."),
			ios: yes(CURSOR_CLOUD, "Cursor iOS app."),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 262,
			hnQueries: ["cursor.com"],
		},
		notes:
			"Supports GitHub (incl. Enterprise Server), GitLab (incl. self-hosted), Bitbucket Cloud and Azure DevOps.",
		compare: {
			href: "/blog/cursor-cloud-agents-vs-zuse",
			label: "Cursor Cloud Agents vs Zuse",
		},
		verification: "hand",
	},
	{
		id: "github-copilot",
		name: "GitHub Copilot (cloud agent)",
		url: "https://github.com/features/copilot",
		category: "Cloud agent",
		description:
			"Copilot works on an issue or prompt in a cloud sandbox, GitHub Actions runner or custom remote environment and opens a pull request.",
		descriptionSource: COPILOT_DOCS,
		since: "2025-05-19",
		sinceSource:
			"https://github.blog/changelog/2025-05-19-github-copilot-coding-agent-in-public-preview/",
		sinceNote: "Coding agent public preview",
		pricing: {
			headline: "$10/mo (Pro)",
			detail:
				"Pro $10/mo includes Copilot in the cloud and third-party agents (Claude Code and Codex). Pro+ $39/mo, Max $100/mo.",
			src: COPILOT_PLANS,
		},
		freeTier: no(
			COPILOT_DOCS,
			"Free plan users keep the previous Copilot Chat experience.",
		),
		license: "Proprietary",
		openSource: no(COPILOT_PLANS, "Closed source commercial product."),
		agents: {
			names: ["Copilot", "Claude Code", "Codex"],
			acp: false,
			src: COPILOT_3P,
			note: "Claude (Agent SDK) and Codex (Codex SDK) agents are in public preview, billed through the Copilot subscription.",
		},
		integrations: {
			names: [
				"GitHub",
				"Slack",
				"Microsoft Teams",
				"Jira",
				"Linear",
				"Azure Boards",
			],
			src: COPILOT_DOCS,
		},
		features: {
			cloud: yes(COPILOT_DOCS, "Runs in a cloud sandbox."),
			remote: yes(
				COPILOT_DOCS,
				"Self-hosted GitHub Actions runners or a remote custom environment.",
			),
			orchestration: unknown(),
			byo: no(
				COPILOT_3P,
				"Third-party agents are powered by the Copilot subscription.",
			),
			mcp: yes(COPILOT_DOCS, "MCP servers can be configured."),
			plugins: yes(COPILOT_DOCS, "Copilot CLI plugin marketplace."),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: yes(COPILOT_DOCS, "Start tasks on GitHub.com."),
			ios: unknown(),
			android: unknown(),
		},
		reputation: { score: null, stars: null, hnStories: null },
		notes:
			"The new Copilot in the cloud reached paid plans on Oct 28, 2026. Only works with repositories hosted on GitHub. One branch and one pull request per task. Actions-based runs are limited to 59 minutes. No reputation score: the product has no own domain or repository to count.",
		compare: {
			href: "/blog/best-cloud-coding-agents#github-copilot-in-the-cloud",
			label: "Copilot in our roundup",
		},
		verification: "hand",
	},
	{
		id: "devin",
		name: "Devin",
		url: "https://devin.ai",
		category: "Cloud agent",
		description:
			"Cognition's autonomous engineer. Devin Cloud runs agents in hosted machines; Devin Desktop (formerly Windsurf) is the local app.",
		descriptionSource: DEVIN_DOCS,
		since: "2024-12-10",
		sinceSource: "https://cognition.com/blog/devin-generally-available",
		sinceNote: "General availability",
		pricing: {
			headline: "$20/mo (Pro)",
			detail:
				"Free plan covers Devin Desktop only. Pro $20/mo adds Devin Cloud; Max $200/mo; Teams $80/mo + $40 per full seat; Enterprise custom with dedicated deployment. Extra usage at API pricing.",
			src: DEVIN_PRICING,
		},
		freeTier: no(
			DEVIN_PRICING,
			"Devin Cloud features are not included in the Free plan.",
		),
		license: "Proprietary",
		openSource: no(DEVIN_PRICING, "Closed source commercial product."),
		agents: {
			names: ["Devin", "Codex", "Claude Code", "OpenCode"],
			acp: true,
			src: "https://devin.ai/blog/windsurf-is-now-devin-desktop",
			note: "Devin Desktop runs Codex, Claude Agent, OpenCode and any ACP agent locally; Devin Cloud runs Devin.",
		},
		integrations: {
			names: [
				"GitHub",
				"GitLab",
				"Bitbucket",
				"Slack",
				"Microsoft Teams",
				"Linear",
				"Jira",
				"API",
			],
			src: DEVIN_PRICING,
		},
		features: {
			cloud: yes(DEVIN_PRICING, "Access to cloud agents (Devin Cloud)."),
			remote: yes(
				DEVIN_PRICING,
				"Enterprise: dedicated deployment in your VPC.",
			),
			orchestration: yes(DEVIN_PRICING, "Concurrent sessions limit per plan."),
			byo: yes(DEVIN_PRICING, "Use your ChatGPT plan (Pro and above)."),
			mcp: yes(DEVIN_DOCS, "MCP Marketplace."),
			plugins: yes(DEVIN_DOCS, "Plugins; plugin MCP servers."),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: unknown(),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 25,
			hnQueries: ["devin.ai"],
		},
		notes: "Launched at $500/mo in Dec 2024; Pro is now $20/mo.",
		compare: { href: "/blog/zuse-vs-devin", label: "Zuse vs Devin" },
		verification: "hand",
	},
	{
		id: "amp",
		name: "Amp",
		url: "https://ampcode.com",
		category: "Cloud agent",
		description:
			"Agentic coding tool with hosted or self-hosted cloud sandboxes (orbs), mobile and Mac apps, and Slack, Linear and GitHub triggers.",
		descriptionSource: AMP_PRICING,
		since: "2025-05-15",
		sinceSource: AMP_NEWS,
		pricing: {
			headline: "Free; $20/mo Individual",
			detail:
				"Hobby is free: pay-as-you-go Amp-hosted orbs, unlimited free self-hosted orbs, your ChatGPT or Claude subscription or own keys, no Amp token fees. Individual $20/mo with 45,000 orb minutes. Teams at no extra charge; Enterprise custom.",
			src: AMP_PRICING,
		},
		freeTier: no(
			AMP_PRICING,
			"Hobby is free, but Amp-hosted orbs are pay-as-you-go; self-hosted orbs are free on your own infrastructure.",
		),
		license: "Proprietary",
		licenseSource: "https://www.npmjs.com/package/@ampcode/cli",
		openSource: no(
			"https://www.npmjs.com/package/@ampcode/cli",
			"npm license: SEE LICENSE IN LICENSE.md (Amp license terms).",
		),
		agents: {
			names: ["Amp", "Claude Code"],
			acp: false,
			src: "https://ampcode.com/news/use-your-claude-plan",
			note: "Claude Code mode via the Claude Agent SDK (Oct 10, 2026).",
		},
		integrations: {
			names: ["GitHub", "GitLab", "Slack", "Linear"],
			src: AMP_NEWS,
		},
		features: {
			cloud: yes(AMP_PRICING, "Amp-hosted orbs."),
			remote: yes(
				"https://ampcode.com/news/self-hosted-orbs",
				"Self-hosted orbs on Docker, E2B, Kubernetes, Modal, Vercel and more.",
			),
			orchestration: yes(AMP_NEWS, "Amp now has new subagents."),
			byo: yes(
				AMP_PRICING,
				"Use your ChatGPT or Claude subscription, or bring your own keys.",
			),
			mcp: yes(AMP_PRICING, "MCP access controls."),
			plugins: yes(AMP_PRICING, "Shared plugins and skills."),
		},
		platforms: {
			macos: yes(AMP_NEWS, "Amp on iOS & macOS (Aug 28, 2026)."),
			windows: unknown(),
			linux: unknown(),
			web: yes(
				AMP_NEWS,
				"Everyone in your workspace can start threads on that machine from ampcode.com.",
			),
			ios: yes(AMP_NEWS, "Amp on iOS & macOS (Aug 28, 2026)."),
			android: yes(AMP_NEWS, "Amp on Android (Oct 27, 2026)."),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 89,
			hnQueries: ["ampcode.com"],
		},
		notes:
			"A model selector replaced the Dial on Nov 12, 2026. Free Agent mode launched Sep 13, 2026. GitLab support arrived Nov 5, 2026.",
		compare: { href: "/blog/amp-vs-zuse", label: "Amp vs Zuse" },
		verification: "hand",
	},
	{
		id: "google-jules",
		name: "Google Jules",
		url: "https://jules.google",
		category: "Cloud agent",
		status: "Shutting down",
		description:
			"Google's asynchronous coding agent that worked on GitHub repositories in cloud VMs.",
		descriptionSource: JULES_CHANGELOG,
		since: "2025-05-19",
		sinceSource: JULES_CHANGELOG,
		pricing: {
			headline: "—",
			detail: "No longer accepting new work.",
			src: JULES_SHUTDOWN,
		},
		freeTier: unknown(),
		license: "Proprietary",
		openSource: no(JULES_SHUTDOWN, "Closed source Google product."),
		agents: { names: ["Jules"], acp: false, src: JULES_CHANGELOG },
		integrations: { names: ["GitHub", "API"], src: JULES_CHANGELOG },
		features: {
			cloud: yes(JULES_CHANGELOG, "Increasing the VM Size to 20GB."),
			remote: unknown(),
			orchestration: unknown(),
			byo: unknown(),
			mcp: unknown(),
			plugins: unknown(),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: unknown(),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 9,
			hnQueries: ["jules.google"],
		},
		notes:
			"Read-only since Nov 11, 2026; winds down Dec 31, 2026. Google points users to Antigravity.",
		compare: {
			href: "/blog/best-cloud-coding-agents#google-jules-is-winding-down",
			label: "Jules in our roundup",
		},
		verification: "hand",
	},
	{
		id: "antigravity-remote-agents",
		name: "Google Antigravity Remote Agents",
		url: "https://antigravity.google",
		category: "Cloud agent",
		status: "Rolling out",
		description:
			"Antigravity agents running in an isolated Google-managed environment, started from the app, the web or the CLI.",
		descriptionSource: ANTIGRAVITY,
		since: null,
		pricing: {
			headline: "Google AI Pro or Ultra",
			detail:
				"For Google AI Pro and Ultra subscribers on personal accounts. Not available on Free, AI Plus, Workspace or Google Cloud accounts.",
			src: ANTIGRAVITY,
		},
		freeTier: no(ANTIGRAVITY, "Not available on the free plan."),
		license: "Proprietary",
		openSource: no(ANTIGRAVITY, "Closed source Google product."),
		agents: { names: ["Antigravity"], acp: false, src: ANTIGRAVITY },
		integrations: { names: ["GitHub", "Google Drive"], src: ANTIGRAVITY },
		features: {
			cloud: yes(ANTIGRAVITY, "Isolated, Google-managed environment."),
			remote: yes(
				ANTIGRAVITY,
				"Remote Control: execution on your own desktop workstation or server.",
			),
			orchestration: unknown(),
			byo: unknown(),
			mcp: unknown(
				"MCP servers installed on your machine are not available in remote agent sessions.",
			),
			plugins: yes(
				ANTIGRAVITY,
				"Remote Agents support plugins that connect your agent to external tools and services.",
			),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: yes(ANTIGRAVITY, "Start on the web."),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 26,
			hnQueries: ["antigravity.google"],
		},
		notes: "Gradual rollout. The CLI needs version 1.4.12 or later.",
		compare: null,
		verification: "hand",
	},
	{
		id: "openhands",
		name: "OpenHands",
		url: "https://www.openhands.dev",
		repoUrl: OH_GH,
		category: "Cloud agent",
		status: "Desktop app in preview",
		description:
			"Open source agent platform. Agent Canvas runs OpenHands, Claude Code, Codex, Gemini CLI or another ACP agent on a local, Docker, VM, Modal or OpenHands Cloud backend.",
		descriptionSource: OH_CANVAS,
		since: "2024-03-13",
		sinceSource: OH_GH,
		sinceNote: "Repository created",
		pricing: {
			headline: "Free self-hosted; Teams $500/mo",
			detail:
				"Agent Canvas is free and self-hosted. Teams $500/mo for up to 10 users (+$50 per extra seat). Enterprise custom. We found no published price for hosted OpenHands Cloud usage.",
			src: OH_PRICING,
		},
		freeTier: unknown(
			"Agent Canvas is free and self-hosted; we found no published price for hosted OpenHands Cloud.",
		),
		license: "MIT",
		licenseSource: OH_GH,
		openSource: yes(OH_GH, "MIT License"),
		agents: {
			names: ["OpenHands", "Claude Code", "Codex", "Gemini CLI"],
			acp: true,
			src: OH_CANVAS,
		},
		integrations: {
			names: ["GitHub", "GitLab", "Bitbucket", "Slack", "Jira", "API"],
			src: OH_CLOUD,
		},
		features: {
			cloud: yes(OH_CLOUD, "OpenHands Cloud backend."),
			remote: yes(
				OH_CANVAS,
				"Backend can run on Docker, a VM (self-hosted), Modal, or OpenHands Cloud.",
			),
			orchestration: unknown(),
			byo: yes(OH_CANVAS, "Direct provider key, or ACP subscription login."),
			mcp: yes(
				"https://docs.openhands.dev/overview/model-context-protocol",
				"Model Context Protocol (MCP) support.",
			),
			plugins: yes(
				"https://docs.openhands.dev/overview/plugins",
				"Plugins bundle skills, hooks, MCP servers, agents and commands.",
			),
		},
		platforms: {
			macos: yes(
				OH_SETUP,
				"Desktop preview installers support Apple silicon and Intel Macs.",
			),
			windows: yes(OH_SETUP, "Desktop preview installers support x64 Windows."),
			linux: yes(
				OH_SETUP,
				"Desktop preview installers support Linux (AppImage or Debian package).",
			),
			web: yes(OH_CANVAS, "Run OpenHands locally in a browser."),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: 93505,
			hnStories: 10,
			repo: "OpenHands/OpenHands",
		},
		notes: "Teams includes a 30-day trial and a 5,000 sessions/month cap.",
		compare: { href: "/blog/openhands-vs-zuse", label: "OpenHands vs Zuse" },
		verification: "hand",
	},
	{
		id: "capy",
		name: "Capy",
		url: "https://capy.ai",
		category: "Cloud agent",
		description:
			"Cloud agent platform that runs many agents on any model, on Capy's cloud machines, your laptop or any server.",
		descriptionSource: CAPY_HOME,
		since: null,
		pricing: {
			headline: "$20/mo (Lite)",
			detail:
				"Lite $20/mo ($1 first week), Pro $100/mo, Max $200 to $1,000/mo. $0 per seat. Cloud machines from $0.10/hour. Your own model plans or API keys at 0% markup.",
			src: CAPY_PRICING,
		},
		freeTier: no(CAPY_PRICING, "No free plan; first week of Lite is $1."),
		license: "Proprietary",
		openSource: no(CAPY_PRICING, "Closed source commercial product."),
		agents: { names: ["Capy"], acp: false, src: CAPY_HOME },
		integrations: {
			names: ["GitHub", "Slack", "Linear", "Vercel", "API"],
			src: CAPY_HOME,
		},
		features: {
			cloud: yes(CAPY_PRICING, "Cloud machines from $0.10/hr."),
			remote: yes(
				CAPY_HOME,
				"Run on your laptop or any server with the Dock CLI.",
			),
			orchestration: yes(
				CAPY_HOME,
				"Orchestrate thousands of agents on any model.",
			),
			byo: yes(
				CAPY_PRICING,
				"Use your ChatGPT, Copilot or SuperGrok plan, or API keys at 0% markup.",
			),
			mcp: yes(
				"https://capy.ai/changelog",
				"Connecting an MCP server keeps the headers and secrets you entered.",
			),
			plugins: yes(
				"https://capy.ai/changelog",
				"Lists plugins, skills, and themes to add to your workspace.",
			),
		},
		platforms: {
			macos: yes(CAPY_HOME, "Desktop app for macOS, Windows, and Linux."),
			windows: yes(CAPY_HOME, "Desktop app for macOS, Windows, and Linux."),
			linux: yes(CAPY_HOME, "Desktop app for macOS, Windows, and Linux."),
			web: yes(CAPY_HOME, "Continue in web."),
			ios: yes(CAPY_HOME, "Offline mode in the iOS app."),
			android: unknown(
				"Android appears on the pricing page as a cloud test phone, not as an app.",
			),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 0,
			hnQueries: ["capy.ai"],
		},
		notes: "Cloud phones on Pro and above.",
		compare: {
			href: "/blog/best-cloud-coding-agents#capy",
			label: "Capy in our roundup",
		},
		verification: "hand",
	},
	{
		id: "conductor",
		name: "Conductor",
		url: "https://www.conductor.build",
		category: "Agent workspace",
		status: "Acquired by Meta; shutdown reversed",
		description:
			"Mac app for running Claude Code, Codex, Cursor and OpenCode agents in parallel worktrees, with optional cloud workspaces.",
		descriptionSource: COND_HOME,
		since: "2025-07",
		sinceSource: "https://www.conductor.build/announcement",
		pricing: {
			headline: "Free local; Cloud on paid plans",
			detail:
				"The local app is free. Cloud needs Pro, Teams or Enterprise; we found no published Pro price. No extra compute fee for now.",
			src: COND_FAQ,
		},
		freeTier: no(
			COND_FAQ,
			"Cloud needs Pro, Teams or Enterprise. The local app is free.",
		),
		license: "Proprietary",
		openSource: no(COND_HOME, "Closed source commercial product."),
		agents: {
			names: ["Claude Code", "Codex", "Cursor", "OpenCode"],
			acp: false,
			src: COND_HOME,
		},
		integrations: { names: ["GitHub", "API"], src: COND_FAQ },
		features: {
			cloud: yes(
				COND_FAQ,
				"Cloud workspaces on Vercel Sandbox, 8 vCPU / 16 GB.",
			),
			remote: no(COND_FAQ, "Self-hosted cloud: not yet available."),
			orchestration: yes(
				"https://www.conductor.build/docs/faq",
				"Docs section: Parallel agents.",
			),
			byo: yes(COND_FAQ, "Use your own subscriptions or API keys."),
			mcp: yes(COND_CHANGELOG, "MCP status indicator."),
			plugins: unknown(),
		},
		platforms: {
			macos: yes(COND_HOME, "macOS app."),
			windows: unknown(),
			linux: unknown(),
			web: unknown(),
			ios: yes(COND_HOME, "iOS app."),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 10,
			hnQueries: ["conductor.build"],
		},
		notes:
			"Joined Meta on Nov 4, 2026 and announced a cloud shutdown for Nov 20; on Nov 13, 2026 (v0.94.2) it said Conductor is not shutting down. Cloud works with GitHub only.",
		compare: {
			href: "/blog/best-cloud-coding-agents#conductor-and-sculptor-mac-first-parallel-agents",
			label: "Conductor in our roundup",
		},
		verification: "hand",
	},
	{
		id: "factory",
		name: "Factory",
		url: "https://factory.ai",
		category: "Cloud agent",
		description:
			"Droid coding agents that run in the CLI, desktop, Slack, Linear and cloud environments, with automations on schedules and events.",
		descriptionSource: FACTORY_PRICING,
		since: null,
		pricing: {
			headline: "Free BYO; $20/mo Pro",
			detail:
				"Free $0 with your own inference (ChatGPT, GitHub Copilot or OpenRouter sign-in, or keys). Pro $20/mo, Plus $100/mo, Max $200/mo, Teams $60 + $40 per member; Business and Enterprise custom. Delegations need a paid plan.",
			src: FACTORY_PRICING,
		},
		freeTier: unknown(
			"The $0 plan uses your own inference; Delegations need a paid plan. We could not confirm whether cloud Environments are included.",
		),
		license: "Proprietary",
		openSource: no(FACTORY_PRICING, "Closed source commercial product."),
		agents: { names: ["Droid"], acp: false, src: FACTORY_DOCS },
		integrations: {
			names: ["GitHub", "Slack", "Linear", "Jira", "Microsoft Teams", "API"],
			src: FACTORY_PRICING,
		},
		features: {
			cloud: yes(FACTORY_DOCS, "Cloud sessions in Environments."),
			remote: yes(
				FACTORY_DOCS,
				"OpenCompute runs sandboxes in your own cloud.",
			),
			orchestration: yes(
				FACTORY_DOCS,
				"Repeatable setup and independent parallel Droids.",
			),
			byo: yes(
				FACTORY_PRICING,
				"Sign in with ChatGPT, GitHub Copilot or OpenRouter, or use your own keys.",
			),
			mcp: unknown(),
			plugins: unknown(),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: unknown(),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 17,
			hnQueries: ["factory.ai"],
		},
		notes:
			"Automations trigger on schedules, Slack, GitHub events and webhooks.",
		compare: null,
		verification: "hand",
	},
	{
		id: "lemonlime",
		name: "LemonLime",
		url: "https://lemonlime.dev",
		repoUrl: LEMON_GH,
		category: "Cloud agent",
		description:
			"Open source workspace that runs Claude Code, Codex, OpenCode and ACP agents locally for free or in cloud VMs on credits.",
		descriptionSource: LEMON,
		since: "2026-11-06",
		sinceSource: LEMON_GH,
		sinceNote: "Repository created",
		pricing: {
			headline: "From $5/mo (credits)",
			detail:
				"Local is free. Cloud credits: Seed $5 (2,500 credits), Zest $40, Squeeze $150, Grove $500.",
			src: LEMON,
		},
		freeTier: no(LEMON, "Cloud VMs run on paid credits. Local use is free."),
		license: "MIT",
		licenseSource: LEMON_GH,
		openSource: yes(LEMON_GH, "MIT License"),
		agents: {
			names: ["Claude Code", "Codex", "OpenCode"],
			acp: true,
			src: LEMON,
		},
		integrations: { names: [], src: LEMON },
		features: {
			cloud: yes(LEMON, "Cloud VMs."),
			remote: yes(LEMON, "Self-hostable."),
			orchestration: yes(
				LEMON,
				"4 agents at a time (Zest), up to 30 on higher plans.",
			),
			byo: yes(
				LEMON,
				"Claude or ChatGPT plans, or Anthropic, OpenAI, Google or OpenRouter keys.",
			),
			mcp: unknown(),
			plugins: unknown(),
		},
		platforms: {
			macos: yes(LEMON, "macOS app."),
			windows: unknown(),
			linux: unknown(),
			web: unknown(),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: 2,
			hnStories: 0,
			repo: "hamedgitty/lemonlime",
		},
		notes: null,
		compare: {
			href: "/blog/best-cloud-coding-agents#lemonlime",
			label: "LemonLime in our roundup",
		},
		verification: "hand",
	},
	{
		id: "ona",
		name: "Ona (formerly Gitpod)",
		url: "https://ona.com",
		category: "Cloud agent",
		status: "Acquired by OpenAI",
		description:
			"Background agents in ephemeral cloud environments, in Ona's cloud or your own VPC.",
		descriptionSource: ONA_OPENAI,
		since: null,
		pricing: {
			headline: "Contact sales",
			detail: "The pricing page now redirects to Contact sales.",
			src: "https://ona.com/contact/sales",
		},
		freeTier: unknown(),
		license: "Proprietary",
		openSource: no(ONA_OPENAI, "Closed source commercial product."),
		agents: { names: ["Ona"], acp: false, src: ONA_OPENAI },
		integrations: { names: [] },
		features: {
			cloud: yes(ONA_OPENAI, "Runs in Ona's cloud."),
			remote: yes(ONA_OPENAI, "Or in your own VPC."),
			orchestration: unknown(),
			byo: unknown(),
			mcp: unknown(),
			plugins: unknown(),
		},
		platforms: {
			macos: unknown(),
			windows: unknown(),
			linux: unknown(),
			web: unknown(),
			ios: unknown(),
			android: unknown(),
		},
		reputation: {
			score: null,
			stars: null,
			hnStories: 8,
			hnQueries: ["ona.com"],
		},
		notes:
			"Joined OpenAI's Codex team: announced June 11, 2026, closed Aug 10, 2026.",
		compare: null,
		verification: "hand",
	},
];
