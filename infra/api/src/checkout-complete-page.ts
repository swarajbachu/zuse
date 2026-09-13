/**
 * Page the billing provider redirects to after checkout. It renders in the
 * customer's browser straight off the worker, so it must be entirely
 * self-contained: no scripts, no network fonts, no external assets. The markup
 * is a hand-port of the product's Receipt Printer surface to plain HTML + CSS.
 *
 * Everything interpolated here is either a constant or a value validated by the
 * caller against the offer catalog / the billing provider — and escaped.
 */

import { clampedText, escapeHtml } from "@zuse/utils/browser-page";

export type CheckoutCompleteStatus = "paid" | "pending" | "failed";

export interface CheckoutCompletePageInput {
	/** Purchased product, already resolved from the provider or the catalog. */
	readonly productName: string;
	readonly status: CheckoutCompleteStatus;
	readonly amount?: { readonly cents: number; readonly currency: string };
	/** Short, human-quotable reference derived from the checkout id. */
	readonly orderRef?: string;
	readonly purchasedAtMs?: number;
}

/** Product names and order references come from the billing provider. */
const MAX_TEXT_LENGTH = 60;

const pad = (value: number): string => String(value).padStart(2, "0");

const formatDate = (nowMs: number): string => {
	const now = new Date(nowMs);
	return `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
};

/** Minor units → display amount. Zero-decimal currencies are not in use here. */
const formatAmount = (amount: {
	readonly cents: number;
	readonly currency: string;
}): string => {
	const currency = amount.currency.trim().toUpperCase().slice(0, 3);
	const value = (amount.cents / 100).toFixed(2);
	return escapeHtml(`${currency === "USD" ? "$" : `${currency} `}${value}`);
};

const STATUS_LABEL: Readonly<Record<CheckoutCompleteStatus, string>> = {
	failed: "Not completed",
	paid: "Paid",
	pending: "Awaiting confirmation",
};

const STATUS_COPY: Readonly<Record<CheckoutCompleteStatus, string>> = {
	failed:
		"This checkout did not complete. Nothing was charged — start it again from Zuse.",
	paid: "Your subscription is active. Zuse picks it up automatically — you can close this tab.",
	pending:
		"We're waiting for the payment to confirm. Zuse picks it up automatically — you can close this tab.",
};

const STYLES = `
:root{
	color-scheme:light dark;
	--bg:#efeeea;
	--fg:#181713;
	--muted:#6c6c64;
	--grid:rgb(24 23 19 / 12%);
	--accent:#caff00;
	--shell:#2a2a27;
	--shell-edge:#181713;
	--screen:#141412;
	--screen-fg:#f2f2ee;
	--paper:#ffffff;
	--ink:#181713;
	--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
	--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
	:root{--bg:#0d0d0d;--fg:#f2f2f2;--muted:#9a9a93;--grid:rgb(242 242 242 / 9%);--shell:#232320;--shell-edge:#0a0a09}
}
*{box-sizing:border-box}
body{
	margin:0;min-height:100vh;display:grid;place-items:start center;
	padding:3rem 1.25rem 4rem;background:var(--bg);color:var(--fg);
	font-family:var(--font-sans);-webkit-font-smoothing:antialiased;
}
.stage{position:relative;display:grid;justify-items:center;width:100%;max-width:24rem}
.stage::before{
	content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55;
	background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);
	background-size:24px 24px;
	-webkit-mask-image:radial-gradient(circle at center,#000,transparent 74%);
	mask-image:radial-gradient(circle at center,#000,transparent 74%);
}
.stage>*{position:relative;z-index:1}
.printer{
	position:relative;z-index:2;width:100%;padding:.75rem .75rem 2rem;
	border:1px solid var(--shell-edge);border-radius:1.5rem;background:var(--shell);
	box-shadow:0 20px 36px -20px rgb(10 10 9 / 55%),0 6px 14px -8px rgb(10 10 9 / 34%),
		inset 0 1px 0 rgb(255 255 255 / 10%),inset 0 -1px 0 rgb(10 10 9 / 55%);
}
.printer-head{
	display:flex;align-items:center;justify-content:space-between;gap:.75rem;
	padding:.25rem .5rem .75rem;color:rgb(242 242 238 / 62%);
}
.screen{
	position:relative;padding:1rem;border:1px solid var(--shell-edge);border-radius:.75rem;
	background:var(--screen);color:var(--screen-fg);
	box-shadow:inset 0 0 24px 4px rgb(10 10 9 / 52%);
}
.screen-row{display:flex;align-items:center;gap:.5rem}
.screen-row span{font-size:.75rem;font-weight:500;line-height:1}
.spinner{
	width:14px;height:14px;flex:none;border-radius:50%;
	border:2px solid rgb(242 242 238 / 25%);border-top-color:var(--accent);
	animation:spin 900ms linear infinite;
}
.dot{width:14px;height:14px;flex:none;border-radius:50%;background:var(--accent)}
.dot.failed{background:#ff7a6b}
@keyframes spin{to{transform:rotate(360deg)}}
.slot{
	position:absolute;left:1.5rem;right:1.5rem;bottom:.75rem;height:8px;border-radius:.25rem;
	background:var(--shell-edge);box-shadow:inset 0 1px 2px rgb(0 0 0 / 60%);
}
.output{position:relative;z-index:1;width:calc(100% - 3rem);margin-top:-1rem;overflow:hidden}
.output::before{
	content:"";position:absolute;left:0;right:0;top:0;height:8px;z-index:2;
	background:rgb(10 10 9 / 55%);filter:blur(6px);
}
.receipt{
	--tooth:14px;
	position:relative;padding:1.75rem 1.5rem 2.25rem;background:var(--paper);color:var(--ink);
	font-family:var(--font-mono);
	background-image:repeating-linear-gradient(180deg,rgb(24 23 19 / 3%) 0 1px,transparent 1px 3px);
	box-shadow:inset 0 0 0 1px rgb(24 23 19 / 12%);
	-webkit-mask:conic-gradient(from -45deg at bottom,#0000,#000 1deg 89deg,#0000 90deg) 50%/var(--tooth) 100% repeat-x;
	mask:conic-gradient(from -45deg at bottom,#0000,#000 1deg 89deg,#0000 90deg) 50%/var(--tooth) 100% repeat-x;
	animation:feed 1.9s linear both;
}
@keyframes feed{
	0%{transform:translateY(calc(-100% + 2px))}
	7.5%{transform:translateY(-91%)}
	10.5%{transform:translateY(-91%)}
	18%{transform:translateY(-81%)}
	21%{transform:translateY(-81%)}
	28.5%{transform:translateY(-70%)}
	31.5%{transform:translateY(-70%)}
	39%{transform:translateY(-58%)}
	42%{transform:translateY(-58%)}
	49.5%{transform:translateY(-45%)}
	52.5%{transform:translateY(-45%)}
	60%{transform:translateY(-32%)}
	63%{transform:translateY(-32%)}
	70.5%{transform:translateY(-20%)}
	73.5%{transform:translateY(-20%)}
	81%{transform:translateY(-10%)}
	84%{transform:translateY(-10%)}
	91.5%{transform:translateY(-3%)}
	94.5%{transform:translateY(-3%)}
	100%{transform:translateY(0)}
}
.receipt h1{
	margin:0;font-family:var(--font-sans);font-size:1.375rem;font-weight:750;
	line-height:.9;letter-spacing:-.05em;text-transform:uppercase;
}
.receipt-meta{
	display:flex;justify-content:space-between;gap:.75rem;margin-top:.75rem;
	font-size:.5rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.6;
}
.rule{margin:1rem 0;border-top:1px dashed currentColor;opacity:.35}
.line{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;font-size:.75rem}
.line+.line{margin-top:.5rem}
.line .label{font-weight:600;overflow-wrap:anywhere}
.line .value{font-weight:700;white-space:nowrap}
.total{font-size:.9375rem;font-weight:750}
.status{
	display:inline-block;margin-top:1rem;padding:.25rem .5rem;
	font-size:.5625rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
	background:var(--accent);color:#181713;
}
.status.failed{background:#ff7a6b}
.receipt p{margin:1rem 0 0;font-size:.625rem;line-height:1.5;opacity:.72}
.receipt .barcode{
	height:26px;margin-top:1.25rem;
	background:repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 4px,currentColor 4px 5px,transparent 5px 8px,currentColor 8px 12px,transparent 12px 14px);
}
.micro{
	font-family:var(--font-mono);font-size:.4375rem;font-weight:700;line-height:1;
	letter-spacing:.09em;text-transform:uppercase;
}
.hint{margin-top:2rem;max-width:22rem;text-align:center;color:var(--muted);font-size:.8125rem;line-height:1.5}
@media (prefers-reduced-motion:reduce){
	*{animation:none!important;transition:none!important}
	.receipt{transform:none}
}
`;

export const renderCheckoutCompletePage = (
	input: CheckoutCompletePageInput,
): string => {
	const failed = input.status === "failed";
	const date = formatDate(input.purchasedAtMs ?? Date.now());
	const amount = input.amount === undefined ? null : formatAmount(input.amount);
	const product =
		clampedText(input.productName, MAX_TEXT_LENGTH) ?? "Zuse subscription";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${failed ? "Checkout not completed" : "Checkout complete"} · Zuse</title>
<style>${STYLES}</style>
</head>
<body>
<main class="stage">
<div class="printer">
<div class="printer-head"><span class="micro">Zuse · Billing</span><span class="micro">${escapeHtml(date)}</span></div>
<div class="screen">
<div class="screen-row">
${
	input.status === "pending"
		? `<span class="spinner" aria-hidden="true"></span>`
		: `<span class="dot${failed ? " failed" : ""}" aria-hidden="true"></span>`
}
<span role="status">${STATUS_LABEL[input.status]}</span>
</div>
</div>
<div class="slot" aria-hidden="true"></div>
</div>
<div class="output">
<article class="receipt" aria-label="Zuse purchase receipt">
<h1>Zuse</h1>
<div class="receipt-meta">
<span>${input.orderRef === undefined ? "Zuse subscription" : `Order ${clampedText(input.orderRef, MAX_TEXT_LENGTH)}`}</span>
<span>${escapeHtml(date)}</span>
</div>
<div class="rule"></div>
<div class="line"><span class="label">${product}</span>${amount === null ? "" : `<span class="value">${amount}</span>`}</div>
${
	amount === null
		? ""
		: `<div class="rule"></div>
<div class="line total"><span class="label">Total</span><span class="value">${amount}</span></div>`
}
<span class="status${failed ? " failed" : ""}">${STATUS_LABEL[input.status]}</span>
<p>${STATUS_COPY[input.status]}</p>
<div class="barcode" aria-hidden="true"></div>
</article>
</div>
<p class="hint">${failed ? "Nothing was charged." : "Provisioning starts automatically once payment is confirmed."}</p>
</main>
</body>
</html>`;
};
