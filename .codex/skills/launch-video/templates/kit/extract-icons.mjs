// Writes compositions/kit/icons.js from the Zuse app's real icon sources, so film UI matches the app.
// Usage (from the Zuse repo root): bun <skill>/templates/kit/extract-icons.mjs > <project>/compositions/kit/icons.js
// Add names to HUGEICONS as a film needs them; lucide icons are inlined below because the app
// imports them from lucide-react (stroke 2), not from @zuse/icons.
import { resolve } from "node:path";

const repo = process.cwd();
const H = await import(
	resolve(repo, "node_modules/@hugeicons/core-free-icons/dist/esm/index.js")
);
const { DITHER_CLOUD_PATH } = await import(
	resolve(repo, "packages/icons/src/dither-cloud.ts")
);

const HUGEICONS = [
	"ComputerIcon",
	"Folder01Icon",
	"GitBranchIcon",
	"AttachmentIcon",
	"SentIcon",
	"Settings01Icon",
	"PackageIcon",
	"TaskDone01Icon",
	"PlugSocketIcon",
	"ConnectIcon",
	"SmartPhone01Icon",
	"BrowserIcon",
	"KeyboardIcon",
	"DocumentAttachmentIcon",
	"GlobeIcon",
	"StarIcon",
	"SquareUnlock01Icon",
	"DashboardSpeedIcon",
	"MapsIcon",
	"ChatDownload01Icon",
	"ComputerTerminal01Icon",
	"GitCompareIcon",
	"GitPullRequestIcon",
	"Edit01Icon",
	"FolderAddIcon",
	"Analytics01Icon",
	"PanelLeftCloseIcon",
	"Menu01Icon",
	"PanelRightCloseIcon",
	"CheckListIcon",
	"CloudIcon",
];

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const out = {};
for (const n of HUGEICONS) {
	const icon = H[n];
	if (!icon) {
		console.error(`missing hugeicon: ${n}`);
		continue;
	}
	const inner = icon
		.map(([tag, attrs]) => {
			const a = Object.entries(attrs)
				.filter(([k]) => k !== "key")
				.map(([k, v]) => `${kebab(k)}="${v}"`)
				.join(" ");
			return `<${tag} ${a}/>`;
		})
		.join("");
	out[n.replace(/Icon$/, "")] =
		`<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}
out.DitherCloud = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><path fill="currentColor" d="${DITHER_CLOUD_PATH}"/></svg>`;

const L = (d) =>
	`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${d}</svg>`;
out.ChevronDown = L('<path d="m6 9 6 6 6-6"/>');
out.ChevronLeft = L('<path d="m15 18-6-6 6-6"/>');
out.ChevronRight = L('<path d="m9 18 6-6-6-6"/>');
out.RefreshCw = L(
	'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
);
out.LoaderCircle = L('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>');
out.Plus = L('<path d="M5 12h14"/><path d="M12 5v14"/>');
out.Check = L('<path d="M20 6 9 17l-5-5"/>');
out.X = L('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
out.Cloud = L(
	'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
);
out.MousePointerClick = L(
	'<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
);
out.Camera = L(
	'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
);

console.log(`window.ZK_ICONS = ${JSON.stringify(out)};`);
