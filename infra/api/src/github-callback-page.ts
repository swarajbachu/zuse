import {
	BROWSER_PAGE_HEADERS,
	clampedText,
	escapeHtml,
} from "@zuse/utils/browser-page";

const pad = (value: number): string => String(value).padStart(2, "0");

const stampMetadata = (nowMs: number) => {
	const now = new Date(nowMs);
	const date = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`;
	return {
		date,
		reference: `ZS-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
	};
};

const STYLES = `
:root{color-scheme:light dark;--bg:#f4f4f2;--fg:#181713;--muted:#6c6c64;--grid:rgb(24 23 19 / 12%);--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--fg:#f2f2f2;--muted:#9a9a93;--grid:rgb(242 242 242 / 9%)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:2.5rem 1.25rem;background:var(--bg);color:var(--fg);font-family:var(--font-sans);-webkit-font-smoothing:antialiased}
.stage{position:relative;display:grid;justify-items:center;gap:2rem;width:100%}
.stage::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:24px 24px;-webkit-mask-image:radial-gradient(circle at center,#000,transparent 74%);mask-image:radial-gradient(circle at center,#000,transparent 74%)}
.stage>*{position:relative;z-index:1}
.stamp-shell{width:min(100%,15rem);filter:drop-shadow(0 1px 1px rgb(15 15 15 / 12%)) drop-shadow(0 12px 22px rgb(15 15 15 / 9%));transform:rotate(-2deg);transition:transform 200ms cubic-bezier(.23,1,.32,1);animation:stamp-in 380ms cubic-bezier(.23,1,.32,1) both}
.stamp-shell:hover{transform:rotate(0deg) scale(1.015)}
@keyframes stamp-in{from{opacity:0;transform:rotate(-2deg) scale(.96)}to{opacity:1;transform:rotate(-2deg) scale(1)}}
.stamp{--hole:5px;--pitch:22px;position:relative;aspect-ratio:4/5;padding:13px;color:#181713;background:linear-gradient(145deg,rgb(255 255 255 / 34%),transparent 42%),#fbfbf8;-webkit-mask:radial-gradient(var(--hole) at 50% 0,#0000 98%,#000) 50% 0/var(--pitch) 100% repeat-x,radial-gradient(var(--hole) at 50% 100%,#0000 98%,#000) 50% 100%/var(--pitch) 100% repeat-x,radial-gradient(var(--hole) at 0 50%,#0000 98%,#000) 0 50%/100% var(--pitch) repeat-y,radial-gradient(var(--hole) at 100% 50%,#0000 98%,#000) 100% 50%/100% var(--pitch) repeat-y;-webkit-mask-composite:source-in;mask:radial-gradient(var(--hole) at 50% 0,#0000 98%,#000) 50% 0/var(--pitch) 100% repeat-x,radial-gradient(var(--hole) at 50% 100%,#0000 98%,#000) 50% 100%/var(--pitch) 100% repeat-x,radial-gradient(var(--hole) at 0 50%,#0000 98%,#000) 0 50%/100% var(--pitch) repeat-y,radial-gradient(var(--hole) at 100% 50%,#0000 98%,#000) 100% 50%/100% var(--pitch) repeat-y;mask-composite:intersect}
.stamp-face{position:relative;display:grid;grid-template-rows:auto 1fr auto;gap:.75rem;height:100%;padding:12px 13px 11px;overflow:hidden;background:#caff00;box-shadow:inset 0 0 0 1px rgb(24 23 19 / 16%)}
.stamp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}
.stamp-head strong{font-family:var(--font-mono);font-size:1.0625rem;font-weight:700;line-height:.8;letter-spacing:-.06em}
.micro{font-family:var(--font-mono);font-size:.4375rem;font-weight:700;line-height:1;letter-spacing:.09em;text-transform:uppercase;opacity:.62}
.stamp-face h1{margin:0;align-self:center;font-size:1.5rem;font-weight:750;line-height:.85;letter-spacing:-.05em;text-transform:uppercase}
.stamp-face p{margin:.5rem 0 0;max-width:11rem;font-size:.5625rem;font-weight:600;line-height:1.4}
.postmark{position:absolute;right:14px;bottom:34px;display:grid;place-items:center;width:92px;height:92px;border:2px solid currentColor;border-radius:50%;opacity:.26;transform:rotate(-14deg);text-align:center}
.postmark::before{content:"";position:absolute;inset:6px;border:1px dashed currentColor;border-radius:50%}
.postmark span{font-family:var(--font-mono);font-size:.4375rem;font-weight:700;line-height:1.35;letter-spacing:.08em;text-transform:uppercase}
.hint{display:grid;justify-items:center;gap:.75rem;text-align:center;max-width:26rem}
.hint p{margin:0;color:var(--muted);font-size:.8125rem;line-height:1.5}
.open{display:inline-flex;align-items:center;padding:.5rem .9rem;border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);border-radius:.625rem;color:var(--fg);font-size:.75rem;font-weight:600;text-decoration:none;transition:border-color 160ms ease,transform 160ms ease}
.open:hover{border-color:color-mix(in srgb,var(--fg) 38%,transparent);transform:translateY(-1px)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

export const renderGithubConnectedPage = (
	accountLogin: string,
	nowMs = Date.now(),
): string => {
	const account = clampedText(accountLogin, 80) ?? "Your GitHub account";
	const { date, reference } = stampMetadata(nowMs);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub connected · Zuse</title><style>${STYLES}</style></head>
<body><main class="stage">
<div class="stamp-shell"><article class="stamp" aria-label="GitHub integration stamp"><div class="stamp-face">
<div class="stamp-head"><span class="micro">Zuse · Integration</span><strong>01</strong></div>
<div><h1>GitHub</h1><p>${account} is connected to Zuse. You can close this tab.</p></div>
<span class="micro">${escapeHtml(reference)}</span><div class="postmark" aria-hidden="true"><span>Connected<br>${escapeHtml(date)}</span></div>
</div></article></div>
<div class="hint"><p>Zuse already picked this up — there is nothing else to do here.</p><a class="open" href="zuse://">Open Zuse</a></div>
</main></body></html>`;
};

export const githubCallbackPageHeaders = BROWSER_PAGE_HEADERS;
