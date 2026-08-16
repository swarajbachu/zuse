/**
 * Pages served by the sign-in loopback (`127.0.0.1:8976-8979`). They render in
 * the user's system browser, so they must be entirely self-contained: no
 * scripts, no network fonts, no external assets — the loopback answers a single
 * request and nothing else is fetchable. The markup is a hand-port of the
 * product's Ticket (account sign-in) and Stamp (integration connect) surfaces to
 * plain HTML + CSS.
 */

import { clampedText, escapeHtml } from "@zuse/utils/browser-page";

export type AuthCallbackFlow = "account" | "linear";
export type AuthCallbackOutcome = "success" | "error";

export interface AuthCallbackPageInput {
	readonly flow: AuthCallbackFlow;
	readonly outcome: AuthCallbackOutcome;
	/** Provider `error_description`; rendered escaped and truncated. */
	readonly detail?: string | undefined;
	/** Injectable clock so the rendered reference is testable. */
	readonly nowMs?: number;
}

/** Providers echo arbitrary text in `error_description`. */
const DETAIL_MAX_LENGTH = 180;

const pad = (value: number): string => String(value).padStart(2, "0");

const stampedAt = (
	nowMs: number,
): {
	readonly date: string;
	readonly issued: string;
	readonly reference: string;
} => {
	const now = new Date(nowMs);
	const day = `${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
	const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
	const date = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`;
	return {
		date,
		issued: `${date} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
		reference: `ZS-${now.getUTCFullYear()}${day}-${time}`,
	};
};

const BASE_STYLES = `
:root{
	color-scheme:light dark;
	--bg:#f4f4f2;
	--fg:#181713;
	--muted:#6c6c64;
	--grid:rgb(24 23 19 / 12%);
	--accent:#caff00;
	--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
	--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
	:root{--bg:#0d0d0d;--fg:#f2f2f2;--muted:#9a9a93;--grid:rgb(242 242 242 / 9%)}
}
*{box-sizing:border-box}
body{
	margin:0;min-height:100vh;display:grid;place-items:center;gap:0;
	padding:2.5rem 1.25rem;background:var(--bg);color:var(--fg);
	font-family:var(--font-sans);-webkit-font-smoothing:antialiased;
}
.stage{position:relative;display:grid;justify-items:center;gap:2rem;width:100%}
.stage::before{
	content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55;
	background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);
	background-size:24px 24px;
	-webkit-mask-image:radial-gradient(circle at center,#000,transparent 74%);
	mask-image:radial-gradient(circle at center,#000,transparent 74%);
}
.stage>*{position:relative;z-index:1}
.hint{
	display:grid;justify-items:center;gap:.75rem;text-align:center;max-width:26rem;
}
.hint p{margin:0;color:var(--muted);font-size:.8125rem;line-height:1.5}
.open{
	display:inline-flex;align-items:center;gap:.4rem;padding:.5rem .9rem;
	border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);border-radius:.625rem;
	color:var(--fg);font-size:.75rem;font-weight:600;letter-spacing:.02em;text-decoration:none;
	transition:border-color 160ms ease,transform 160ms ease;
}
.open:hover{border-color:color-mix(in srgb,var(--fg) 38%,transparent);transform:translateY(-1px)}
.micro{
	font-family:var(--font-mono);font-size:.4375rem;font-weight:700;line-height:1;
	letter-spacing:.09em;text-transform:uppercase;opacity:.62;
}
@media (prefers-reduced-motion:reduce){
	*{animation:none!important;transition:none!important}
}
`;

const TICKET_STYLES = `
.ticket-shell{
	width:min(100%,18rem);
	filter:drop-shadow(0 1px 1px rgb(15 15 15 / 10%)) drop-shadow(0 18px 26px rgb(15 15 15 / 13%));
	transform:rotate(-1.4deg);
	transition:transform 220ms cubic-bezier(0.23,1,0.32,1);
	animation:ticket-in 420ms cubic-bezier(0.23,1,0.32,1) both;
}
.ticket-shell:hover{transform:rotate(0deg) scale(1.015)}
@keyframes ticket-in{
	from{opacity:0;transform:rotate(-1.4deg) translateY(14px)}
	to{opacity:1;transform:rotate(-1.4deg) translateY(0)}
}
.ticket{
	--corner:0px;--notch:13px;--stub:112px;
	position:relative;display:grid;grid-template-rows:minmax(0,1fr) var(--stub);
	min-height:29rem;color:var(--ink);
	background:linear-gradient(145deg,rgb(255 255 255 / 14%),transparent 42%),var(--paper);
	clip-path:polygon(
		0 var(--corner),
		var(--corner) 0,
		calc(100% - var(--corner)) 0,
		100% var(--corner),
		100% calc(100% - var(--stub) - var(--notch)),
		calc(100% - var(--notch)) calc(100% - var(--stub)),
		100% calc(100% - var(--stub) + var(--notch)),
		100% calc(100% - var(--corner)),
		calc(100% - var(--corner)) 100%,
		var(--corner) 100%,
		0 calc(100% - var(--corner)),
		0 calc(100% - var(--stub) + var(--notch)),
		var(--notch) calc(100% - var(--stub)),
		0 calc(100% - var(--stub) - var(--notch))
	);
}
.ticket-body{
	position:relative;display:grid;grid-template-rows:auto 1fr auto auto;gap:1rem;
	padding:20px 21px 25px;min-height:0;overflow:hidden;
}
.ticket-body::after{
	content:"";position:absolute;left:calc(var(--notch) + 6px);right:calc(var(--notch) + 6px);
	bottom:0;border-bottom:1px dashed currentColor;opacity:.3;
}
.ticket-top{
	display:flex;justify-content:space-between;gap:.75rem;
	font-family:var(--font-mono);font-size:.4375rem;font-weight:700;line-height:1;
	letter-spacing:.09em;text-transform:uppercase;opacity:.72;
}
.ticket-pattern{
	align-self:stretch;min-height:64px;opacity:.16;
	background:repeating-linear-gradient(45deg,currentColor 0 5px,transparent 5px 11px);
}
.ticket h1{
	margin:0;font-size:1.75rem;font-weight:750;line-height:.84;
	letter-spacing:-.05em;text-transform:uppercase;
}
.ticket p{
	margin:.75rem 0 0;max-width:12rem;font-size:.5625rem;font-weight:600;
	line-height:1.4;letter-spacing:-.01em;
}
.ticket-facts{display:grid;grid-template-columns:1fr 1fr;gap:.625rem;margin:0}
.ticket-facts div{display:flex;flex-direction:column;gap:3px;min-width:0}
.ticket-facts dt{
	font-family:var(--font-mono);font-size:.375rem;font-weight:700;line-height:1;
	letter-spacing:.09em;text-transform:uppercase;opacity:.62;
}
.ticket-facts dd{
	margin:0;font-family:var(--font-mono);font-size:.5625rem;font-weight:700;
	line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ticket-stub{
	display:flex;flex-direction:column;justify-content:space-between;gap:.875rem;
	padding:20px 21px 18px;min-height:0;overflow:hidden;
}
.ticket-stub-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.ticket-stub-row div{display:flex;flex-direction:column;gap:4px;min-width:0}
.ticket-stub-row div:last-child{align-items:flex-end;text-align:right}
.ticket-stub strong{font-size:.8125rem;font-weight:750;line-height:1;text-transform:uppercase}
.ticket-stub .reference{
	font-family:var(--font-mono);font-size:.5rem;font-weight:750;line-height:1;letter-spacing:-.02em;
}
.barcode{
	height:22px;width:100%;
	background:repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 4px,currentColor 4px 5px,transparent 5px 8px,currentColor 8px 12px,transparent 12px 14px);
}
`;

const STAMP_STYLES = `
.stamp-shell{
	width:min(100%,15rem);
	filter:drop-shadow(0 1px 1px rgb(15 15 15 / 12%)) drop-shadow(0 12px 22px rgb(15 15 15 / 9%));
	transform:rotate(-2deg);
	transition:transform 200ms cubic-bezier(0.23,1,0.32,1);
	animation:stamp-in 380ms cubic-bezier(0.23,1,0.32,1) both;
}
.stamp-shell:hover{transform:rotate(0deg) scale(1.015)}
@keyframes stamp-in{
	from{opacity:0;transform:rotate(-2deg) scale(.96)}
	to{opacity:1;transform:rotate(-2deg) scale(1)}
}
.stamp{
	--hole:5px;--pitch:22px;
	position:relative;aspect-ratio:4/5;padding:13px;color:var(--ink);
	background:linear-gradient(145deg,rgb(255 255 255 / 34%),transparent 42%),#fbfbf8;
	-webkit-mask:
		radial-gradient(var(--hole) at 50% 0,#0000 98%,#000) 50% 0/var(--pitch) 100% repeat-x,
		radial-gradient(var(--hole) at 50% 100%,#0000 98%,#000) 50% 100%/var(--pitch) 100% repeat-x,
		radial-gradient(var(--hole) at 0 50%,#0000 98%,#000) 0 50%/100% var(--pitch) repeat-y,
		radial-gradient(var(--hole) at 100% 50%,#0000 98%,#000) 100% 50%/100% var(--pitch) repeat-y;
	-webkit-mask-composite:source-in;
	mask:
		radial-gradient(var(--hole) at 50% 0,#0000 98%,#000) 50% 0/var(--pitch) 100% repeat-x,
		radial-gradient(var(--hole) at 50% 100%,#0000 98%,#000) 50% 100%/var(--pitch) 100% repeat-x,
		radial-gradient(var(--hole) at 0 50%,#0000 98%,#000) 0 50%/100% var(--pitch) repeat-y,
		radial-gradient(var(--hole) at 100% 50%,#0000 98%,#000) 100% 50%/100% var(--pitch) repeat-y;
	mask-composite:intersect;
}
.stamp-face{
	position:relative;display:grid;grid-template-rows:auto 1fr auto;gap:.75rem;
	height:100%;padding:12px 13px 11px;overflow:hidden;
	background:var(--paper);
	box-shadow:inset 0 0 0 1px rgb(24 23 19 / 16%);
}
.stamp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}
.stamp-head strong{font-family:var(--font-mono);font-size:1.0625rem;font-weight:700;line-height:.8;letter-spacing:-.06em}
.stamp-face h1{
	margin:0;align-self:center;font-size:1.5rem;font-weight:750;line-height:.85;
	letter-spacing:-.05em;text-transform:uppercase;
}
.stamp-face p{margin:.5rem 0 0;max-width:11rem;font-size:.5625rem;font-weight:600;line-height:1.4}
.postmark{
	position:absolute;right:14px;bottom:34px;display:grid;place-items:center;
	width:92px;height:92px;border:2px solid currentColor;border-radius:50%;
	opacity:.26;transform:rotate(-14deg);text-align:center;
}
.postmark::before{
	content:"";position:absolute;inset:6px;border:1px dashed currentColor;border-radius:50%;
}
.postmark span{
	font-family:var(--font-mono);font-size:.4375rem;font-weight:700;line-height:1.35;
	letter-spacing:.08em;text-transform:uppercase;
}
`;

const documentShell = (input: {
	readonly title: string;
	readonly styles: string;
	readonly body: string;
}): string =>
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>${BASE_STYLES}${input.styles}</style>
</head>
<body>
${input.body}
</body>
</html>`;

const openAppLink = `<a class="open" href="zuse://">Open Zuse</a>`;

const ticket = (input: {
	readonly outcome: AuthCallbackOutcome;
	readonly detail: string | null;
	readonly issued: string;
	readonly reference: string;
}): string => {
	const success = input.outcome === "success";
	const paper = success ? "#caff00" : "#ff7a6b";
	const headline = success ? "You’re<br>signed in" : "Sign-in<br>didn’t finish";
	const copy = success
		? "Your Zuse account is ready. Head back to the app — you can close this tab."
		: (input.detail ??
			"The provider cancelled or rejected this sign-in. Return to Zuse and try again.");
	return `<div class="ticket-shell">
<article class="ticket" style="--paper:${paper};--ink:#181713" aria-label="Zuse sign-in ticket">
<div class="ticket-body">
<div class="ticket-top"><span>Zuse · Account</span><span>${success ? "Admitted" : "Void"}</span></div>
<div class="ticket-pattern" aria-hidden="true"></div>
<div>
<h1>${headline}</h1>
<p>${copy}</p>
</div>
<dl class="ticket-facts">
<div><dt>Issued (UTC)</dt><dd>${escapeHtml(input.issued)}</dd></div>
<div><dt>Status</dt><dd>${success ? "Signed in" : "Not signed in"}</dd></div>
</dl>
</div>
<div class="ticket-stub">
<div class="ticket-stub-row">
<div><span class="micro">Admit</span><strong>${success ? "One" : "None"}</strong></div>
<div><span class="micro">Reference</span><span class="reference">${escapeHtml(input.reference)}</span></div>
</div>
<div class="barcode" aria-hidden="true"></div>
</div>
</article>
</div>`;
};

const stamp = (input: {
	readonly outcome: AuthCallbackOutcome;
	readonly detail: string | null;
	readonly date: string;
	readonly reference: string;
}): string => {
	const success = input.outcome === "success";
	const paper = success ? "#caff00" : "#ff7a6b";
	const copy = success
		? "Linear is connected to Zuse. You can close this tab."
		: (input.detail ??
			"Linear did not finish connecting. Return to Zuse and try again.");
	return `<div class="stamp-shell">
<article class="stamp" style="--ink:#181713" aria-label="Linear integration stamp">
<div class="stamp-face" style="--paper:${paper}">
<div class="stamp-head"><span class="micro">Zuse · Integration</span><strong>${success ? "01" : "00"}</strong></div>
<div>
<h1>Linear</h1>
<p>${copy}</p>
</div>
<span class="micro">${escapeHtml(input.reference)}</span>
<div class="postmark" aria-hidden="true"><span>${success ? "Connected" : "Declined"}<br>${escapeHtml(input.date)}</span></div>
</div>
</article>
</div>`;
};

export const renderAuthCallbackPage = (
	input: AuthCallbackPageInput,
): string => {
	const detail = clampedText(input.detail, DETAIL_MAX_LENGTH);
	const { date, issued, reference } = stampedAt(input.nowMs ?? Date.now());
	const success = input.outcome === "success";
	const isLinear = input.flow === "linear";
	const artwork = isLinear
		? stamp({ date, detail, outcome: input.outcome, reference })
		: ticket({ detail, issued, outcome: input.outcome, reference });
	const title = isLinear
		? success
			? "Linear connected · Zuse"
			: "Linear not connected · Zuse"
		: success
			? "Signed in · Zuse"
			: "Sign-in failed · Zuse";
	const hint = success
		? "Zuse already picked this up — there is nothing else to do here."
		: "Nothing was changed. Start the flow again from Zuse.";
	return documentShell({
		body: `<main class="stage">
${artwork}
<div class="hint">
<p>${hint}</p>
${openAppLink}
</div>
</main>`,
		styles: isLinear ? STAMP_STYLES : TICKET_STYLES,
		title,
	});
};

export const renderNotFoundPage = (): string =>
	documentShell({
		body: `<main class="stage">
<div class="hint">
<p><strong>Nothing here.</strong></p>
<p>This address only answers Zuse sign-in callbacks.</p>
${openAppLink}
</div>
</main>`,
		styles: "",
		title: "Not found · Zuse",
	});
