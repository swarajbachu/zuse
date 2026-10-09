export interface HtmlTheme {
	readonly appearance: "dark" | "light";
	readonly variables: Readonly<Record<string, string>>;
}

export const defaultHtmlTheme = (appearance: "dark" | "light"): HtmlTheme => ({
	appearance,
	variables: {
		"--background": appearance === "dark" ? "#101010" : "#ffffff",
		"--foreground": appearance === "dark" ? "#eeeeee" : "#171717",
		"--muted": appearance === "dark" ? "#242424" : "#f4f4f5",
		"--muted-foreground": appearance === "dark" ? "#a1a1aa" : "#71717a",
		"--primary": "#60a5fa",
		"--border": appearance === "dark" ? "#303030" : "#e4e4e7",
		"--font-sans": "system-ui, sans-serif",
	},
});

// Frames have an opaque origin. Neither scripts nor remote assets inherit app authority.
export const HTML_DOCUMENT_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: zuse-visual-http: zuse-visual-https:; style-src 'unsafe-inline' https: http: zuse-visual-http: zuse-visual-https:; img-src data: blob: https: http: zuse-visual-http: zuse-visual-https:; font-src data: https: http: zuse-visual-http: zuse-visual-https:; media-src data: blob: https: http: zuse-visual-http: zuse-visual-https:; connect-src https: http: zuse-visual-http: zuse-visual-https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function prepareHtmlDocument(
	html: string,
	theme: HtmlTheme = defaultHtmlTheme("dark"),
): string {
	// Prefix before any author-controlled markup: a fake <head> in a comment or
	// raw-text element must never move the policy behind a script.
	const initial = JSON.stringify(theme).replace(/</g, "\\u003c");
	return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${HTML_DOCUMENT_CSP}"><style id="zuse-visual-theme"></style><script>
(() => {
 const sheet = document.getElementById('zuse-visual-theme');
 function apply(t) {
  if (!t || !t.variables || (t.appearance !== 'dark' && t.appearance !== 'light')) return;
  let css = ':root{color-scheme:' + t.appearance + ';';
  for (const [k,v] of Object.entries(t.variables)) if (/^--[a-z0-9-]+$/.test(k) && typeof v === 'string') css += k + ':' + v.replace(/[;{}<>]/g,'') + ';';
  sheet.textContent = css + '}*{box-sizing:border-box}html,body{margin:0;min-height:0}body{display:flow-root;background:transparent;color:var(--foreground);font-family:var(--font-sans);overflow-wrap:break-word}img,svg,canvas{max-width:100%}';
 }
 apply(${initial});
 addEventListener('message', e => { if(e.source === parent && e.data?.type === 'zuse:visual-theme') apply(e.data.theme); });
 let last = 0, pending = false;
 function measure() { pending = false; const b = document.body; if(!b) return; const height = Math.ceil(Math.max(b.scrollHeight, b.getBoundingClientRect().height)); if(height !== last){last=height;parent.postMessage({type:'zuse:visual-size',height},'*');} }
 function schedule(){if(!pending){pending=true;requestAnimationFrame(measure);}}
 addEventListener('DOMContentLoaded', () => {const o = new ResizeObserver(schedule);o.observe(document.body);schedule();});
 addEventListener('load',schedule);
})();
</script>${html}`;
}

export function readVisualHeight(data: unknown): number | null {
	if (data === null || typeof data !== "object") return null;
	const value = data as Record<string, unknown>;
	return value.type === "zuse:visual-size" &&
		typeof value.height === "number" &&
		Number.isFinite(value.height) &&
		value.height > 0
		? Math.max(80, Math.min(2000, Math.ceil(value.height)))
		: null;
}

/** Apply current display policy even to attachments persisted by an older build. */
export function prepareHtmlDisplayUrl(src: string): string {
	let html = new TextDecoder().decode(
		Uint8Array.from(atob(src.slice("data:text/html;base64,".length)), (c) =>
			c.charCodeAt(0),
		),
	);
	// Upgrade the known bootstrap policy in memory; saved HTML remains unchanged.
	const legacy = HTML_DOCUMENT_CSP.replaceAll(
		" zuse-visual-http: zuse-visual-https:",
		"",
	);
	html = html.replace(
		`<meta http-equiv="Content-Security-Policy" content="${legacy}">`,
		`<meta http-equiv="Content-Security-Policy" content="${HTML_DOCUMENT_CSP}">`,
	);
	const prefix = `<meta http-equiv="Content-Security-Policy" content="${HTML_DOCUMENT_CSP}">`;
	const bytes = new TextEncoder().encode(prefix + html);
	let encoded = "";
	for (let i = 0; i < bytes.length; i += 8192)
		encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return `data:text/html;base64,${btoa(encoded)}`;
}
