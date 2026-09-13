import { BROWSER_PAGE_HEADERS, escapeHtml } from "@zuse/utils/browser-page";
import type { AppEnv } from "./types.ts";
export const htmlEscape = escapeHtml;
export const SLACK_PAGE_HEADERS = {
	...BROWSER_PAGE_HEADERS,
	// no-referrer makes native form POSTs send Origin: null. Keep same-origin
	// forms verifiable without sending callback URLs to external destinations.
	"referrer-policy": "same-origin",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
export const appOrigin = (env: AppEnv): string => {
	const url = new URL(env.APP_ORIGIN);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("invalid_app_origin");
	return url.origin;
};
export const cookie = (name: string, token: string, seconds: number): string =>
	`${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
export const readCookie = (request: Request, name: string): string =>
	request.headers
		.get("cookie")
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1) ?? "";
export const redirect = (url: string, setCookie?: string): Response =>
	new Response(null, {
		status: 303,
		headers: {
			location: url,
			"cache-control": "no-store",
			...(setCookie ? { "set-cookie": setCookie } : {}),
		},
	});
export const page = (body: string, status = 200): Response =>
	new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zuse · Slack</title><style>
:root{color-scheme:light;--ink:#252722;--muted:#65695e;--paper:#fafbf8}
*{box-sizing:border-box}
body{font:14px/1.6 system-ui,-apple-system,sans-serif;margin:0;padding:80px 24px;background:var(--paper);color:var(--ink)}
main{max-width:560px;margin:0 auto}
.brand{font-size:22px;font-weight:650;letter-spacing:-.8px;margin-bottom:56px}
.brand span{font-size:13px;font-weight:450;color:var(--muted);letter-spacing:0;margin-left:10px}
h1{font-size:30px;line-height:1.2;letter-spacing:-1px;font-weight:550;margin:0 0 20px;max-width:480px}
h2{font-size:17px;line-height:1.4;font-weight:600;margin:32px 0 12px}
p{color:#60645b;margin:16px 0;max-width:500px}
a{color:inherit;text-underline-offset:3px}
a.action{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border-radius:5px;background:var(--ink);color:#fff;text-decoration:none;font-size:13px;font-weight:550;margin:12px 0}
a.action:hover,button:hover{background:#42473b}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #597345;outline-offset:3px}
label{display:block;margin:12px 0}
input,select,button{height:28px;font:inherit;border:0;border-radius:4px;background:#eceee7;padding:0 8px}
input,select{display:block;width:100%;margin-top:5px}
button{background:var(--ink);color:#fff;cursor:pointer}
section{margin:20px 0;padding:12px;background:#eef0e9;border-radius:6px}
.muted{font-size:12px;color:var(--muted);margin-top:24px}
@media(max-width:600px){body{padding:48px 24px}.brand{margin-bottom:40px}h1{font-size:27px}}
</style><main>${body}</main></html>`,
		{
			status,
			headers: SLACK_PAGE_HEADERS,
		},
	);
