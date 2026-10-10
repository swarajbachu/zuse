import { createHash } from "node:crypto";
import { browserPageHeaders, escapeHtml } from "./browser-page.ts";
import {
	DITHER_BACKGROUND_SCRIPT,
	DITHER_BACKGROUND_SCRIPT_SOURCE,
	DITHER_BACKGROUND_STYLES,
} from "./dither-background.ts";

/**
 * After an action finishes in another tab (approving permissions on GitHub),
 * returning to this tab resumes the flow at the row's same-origin resume URL.
 */
const RESUME_SCRIPT = `(()=>{const k="zuse.integration.resume";document.addEventListener("click",e=>{const a=e.target instanceof Element?e.target.closest("a[data-resume]"):null;if(a)sessionStorage.setItem(k,a.dataset.resume);});const go=()=>{if(document.visibilityState!=="visible")return;const u=sessionStorage.getItem(k);if(!u)return;sessionStorage.removeItem(k);const t=new URL(u,location.href);if(t.origin===location.origin)location.assign(t.href);};document.addEventListener("visibilitychange",go);addEventListener("focus",go);})();`;
const RESUME_SCRIPT_SOURCE = `'sha256-${createHash("sha256").update(RESUME_SCRIPT).digest("base64")}'`;
const SUBMIT_SCRIPT = `(()=>{let busy=false;const reset=()=>{busy=false;document.querySelectorAll("form[aria-busy]").forEach(f=>f.removeAttribute("aria-busy"));document.querySelector("[data-submit-status]").hidden=true;document.querySelectorAll("button[data-original-label]").forEach(b=>{b.disabled=false;b.textContent=b.dataset.originalLabel;});};document.addEventListener("submit",e=>{const f=e.target;if(!(f instanceof HTMLFormElement)||!f.dataset.pending)return;if(busy){e.preventDefault();return;}busy=true;f.setAttribute("aria-busy","true");const s=document.querySelector("[data-submit-status]");s.textContent=f.dataset.pending;s.hidden=false;document.querySelectorAll("button[type=submit]").forEach(b=>{b.dataset.originalLabel=b.textContent;b.disabled=true;});const b=f.querySelector("button");b.textContent=f.dataset.pendingLabel;});document.addEventListener("click",e=>{if(busy&&e.target instanceof Element&&e.target.closest("a"))e.preventDefault();},true);addEventListener("pageshow",e=>{if(e.persisted)reset();});})();`;
const SUBMIT_SCRIPT_SOURCE = `'sha256-${createHash("sha256").update(SUBMIT_SCRIPT).digest("base64")}'`;

/** Integration pages run the backdrop and, when needed, submit and resume feedback. */
export const INTEGRATION_PAGE_SCRIPT_SOURCE = DITHER_BACKGROUND_SCRIPT_SOURCE;
/** Account avatars are the only remote resource these pages load. */
const AVATAR_ORIGIN = "https://avatars.githubusercontent.com";
export const INTEGRATION_PAGE_HEADERS = browserPageHeaders(
	[INTEGRATION_PAGE_SCRIPT_SOURCE, RESUME_SCRIPT_SOURCE, SUBMIT_SCRIPT_SOURCE],
	[AVATAR_ORIGIN],
);

// Colours match the dither backdrop's paper so the card floats on one surface.
const STYLES = `
:root{color-scheme:light dark;--bg:#f4f4f2;--panel:rgb(255 255 255 / 86%);--fg:#181713;--muted:#6c6c64;--ring:rgb(24 23 19 / 8%);--soft:rgb(24 23 19 / 4%);--hover:rgb(24 23 19 / 6%);--grid:rgb(24 23 19 / 10%);--font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0d0d0d;--panel:rgb(22 22 21 / 84%);--fg:#f2f2f2;--muted:#9a9a93;--ring:rgb(255 255 255 / 7%);--soft:rgb(255 255 255 / 3%);--hover:rgb(255 255 255 / 6%);--grid:rgb(242 242 242 / 7%)}}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:40px 20px;background:var(--bg);color:var(--fg);font:13px/1.5 var(--font);-webkit-font-smoothing:antialiased}
.stage{position:relative;width:100%;display:grid;justify-items:center}
.stage::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:24px 24px;-webkit-mask-image:radial-gradient(circle at center,#000,transparent 74%);mask-image:radial-gradient(circle at center,#000,transparent 74%)}
.card{position:relative;z-index:1;width:min(100%,448px);padding:24px;border-radius:14px;background:var(--panel);box-shadow:0 0 0 1px var(--ring);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);animation:card-in 360ms cubic-bezier(.23,1,.32,1) both}
@keyframes card-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.eyebrow{display:flex;align-items:center;gap:6px;margin:0 0 18px;font:700 10px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.eyebrow strong{color:var(--fg)}
h1{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.025em;font-weight:600;text-wrap:balance}
.description{margin:4px 0 0;color:var(--muted);overflow-wrap:anywhere}
.list{display:grid;gap:2px;margin:20px 0 0;padding:4px;border-radius:10px;background:var(--soft)}
.row{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:44px;padding:6px 6px 6px 8px;border-radius:7px;color:inherit;text-decoration:none}
a.row:hover{background:var(--hover)}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--hover);font:600 12px/1 var(--mono);text-transform:uppercase}
.mark svg{width:12px;height:12px;color:var(--muted)}
img.mark{object-fit:cover}
.name{display:block;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{display:flex;align-items:center;gap:6px;overflow:hidden;white-space:nowrap;font-size:12px;color:var(--muted)}
.meta a{position:relative;display:inline-flex;align-items:center;gap:2px;color:inherit;text-decoration:none}
.meta a:hover{color:var(--fg)}
.meta svg{width:10px;height:10px}
.muted{color:var(--muted)}
a.row:hover .muted{color:var(--fg)}
form{margin:0}
.buttons{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0}
.button{position:relative;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:0;border-radius:7px;background:var(--fg);color:var(--bg);font:500 12px var(--font);text-decoration:none;cursor:pointer;white-space:nowrap}
.button:hover{opacity:.88}
.button:active{transform:translateY(1px)}
.button.secondary{background:var(--hover);color:var(--fg)}
.button:disabled{cursor:wait;opacity:.6}
.button:disabled:active{transform:none}
[data-submit-status]{margin:12px 0 0;font-size:12px}
.hint{margin:16px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
:is(a,button):focus-visible{outline:2px solid var(--fg);outline-offset:2px}
@media(max-width:440px){body{padding:24px 16px}.card{padding:20px}.meta{flex-wrap:wrap;column-gap:6px;row-gap:0}}
@media(pointer:coarse){.meta a::before,.button::before{content:"";position:absolute;inset:-8px 0}}
@media(prefers-reduced-motion:reduce){.card{animation:none}}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

const EXTERNAL = `<svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M3.5 8.5l5-5M4.5 3.5h4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PLUS = `<svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M6 2.5v7M2.5 6h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

type LinkAction = {
	readonly label: string;
	readonly href: string;
	/** Renders the link as an account row that needs action elsewhere first. */
	readonly accountName?: string;
	readonly description?: string;
	readonly avatarUrl?: string;
	/** Same-origin URL that resumes the flow when the person returns. */
	readonly resumeHref?: string;
};
type FormAction = {
	readonly label: string;
	readonly action: string;
	readonly csrf: string;
	/** Renders the action as a row in the account list. */
	readonly accountName?: string;
	readonly description?: string;
	readonly manageUrl?: string;
	/** GitHub avatar; other hosts fall back to the initial. */
	readonly avatarUrl?: string;
};

export interface IntegrationPageInput {
	readonly integration: string;
	readonly title?: string;
	readonly description: string;
	readonly status: string;
	readonly hint: string;
	readonly actions: readonly (LinkAction | FormAction)[];
}

const form = (action: FormAction, className: string, ariaLabel: string) =>
	`<form method="post" action="${escapeHtml(action.action)}" data-pending-label="${action.accountName ? "Connecting…" : "Working…"}" data-pending="${escapeHtml(action.accountName ? `Connecting ${action.accountName}… This may take a few seconds.` : `${action.label}… Please wait.`)}"><input type="hidden" name="csrf" value="${escapeHtml(action.csrf)}"><button class="${className}" type="submit" aria-label="${escapeHtml(ariaLabel)}">${escapeHtml(action.label)}</button></form>`;

const accountRow = (
	action: (FormAction | LinkAction) & { readonly accountName: string },
) => {
	const meta = [
		action.description ? `<span>${escapeHtml(action.description)}</span>` : "",
		"manageUrl" in action && action.manageUrl
			? `<a href="${escapeHtml(action.manageUrl)}" target="_blank" rel="noopener noreferrer">Manage access${EXTERNAL}<span class="sr-only"> to repositories (opens in a new tab)</span></a>`
			: "",
	]
		.filter(Boolean)
		.join(`<span aria-hidden="true">·</span>`);
	const mark = action.avatarUrl?.startsWith(`${AVATAR_ORIGIN}/`)
		? `<img class="mark" src="${escapeHtml(action.avatarUrl)}" alt="" width="28" height="28">`
		: `<span class="mark" aria-hidden="true">${escapeHtml(Array.from(action.accountName)[0] ?? "")}</span>`;
	return `<div class="row">${mark}<div><span class="name">${escapeHtml(action.accountName)}</span>${meta ? `<div class="meta">${meta}</div>` : ""}</div>${
		"href" in action
			? `<a class="button secondary" href="${escapeHtml(action.href)}"${action.resumeHref ? ` data-resume="${escapeHtml(action.resumeHref)}"` : ""} target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(`${action.label}: ${action.accountName}`)}">${escapeHtml(action.label)}</a>`
			: form(action, "button", `${action.label}: ${action.accountName}`)
	}</div>`;
};

const isAccount = (
	action: LinkAction | FormAction,
): action is (FormAction | LinkAction) & { readonly accountName: string } =>
	"accountName" in action && action.accountName !== undefined;

export const renderIntegrationPage = (input: IntegrationPageInput): string => {
	const accounts = input.actions.filter(isAccount);
	const others = input.actions.filter((action) => !isAccount(action));
	// With accounts to pick from, the remaining links join the list as quiet
	// rows; otherwise they are the page's buttons, the first one primary.
	const body =
		accounts.length > 0
			? `<div class="list">${accounts.map(accountRow).join("")}${others
					.map((action) =>
						"href" in action
							? `<a class="row" href="${escapeHtml(action.href)}"><span class="mark" aria-hidden="true">${PLUS}</span><span class="muted">${escapeHtml(action.label)}</span></a>`
							: `<div class="row"><span></span><span></span>${form(action, "button secondary", action.label)}</div>`,
					)
					.join("")}</div>`
			: others.length > 0
				? `<div class="buttons">${others
						.map((action, index) => {
							const className = index === 0 ? "button" : "button secondary";
							return "href" in action
								? `<a class="${className}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
								: form(action, className, action.label);
						})
						.join("")}</div>`
				: "";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.integration)} ${escapeHtml(input.status.toLowerCase())} · Zuse</title><style>${STYLES}${DITHER_BACKGROUND_STYLES}</style></head><body><main class="stage"><section class="card"><p class="eyebrow"><strong>Zuse</strong><span aria-hidden="true">/</span>${escapeHtml(input.integration)}</p><h1>${escapeHtml(input.title ?? `${input.integration} connected`)}</h1><p class="description">${escapeHtml(input.description)}</p>${body}<p data-submit-status role="status" hidden></p><p class="hint">${escapeHtml(input.hint)}</p></section></main>${DITHER_BACKGROUND_SCRIPT}${input.actions.some((action) => "action" in action) ? `<script>${SUBMIT_SCRIPT}</script>` : ""}${
		input.actions.some((action) => "resumeHref" in action && action.resumeHref)
			? `<script>${RESUME_SCRIPT}</script>`
			: ""
	}</body></html>`;
};
