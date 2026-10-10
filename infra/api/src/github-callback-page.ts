import { createHash } from "node:crypto";
import { escapeHtml } from "@zuse/utils/browser-page";
import {
	INTEGRATION_PAGE_HEADERS,
	renderIntegrationPage,
} from "@zuse/utils/integration-page";

// One request at a time, paused in background tabs, with bounded backoff. A
// successful check resumes OAuth; the account chooser still confirms the link.
const APPROVAL_POLL_SCRIPT = `(()=>{const f=document.querySelector("form[data-approval-check]");if(!f)return;let busy=false,stopped=false,timer,delay=5000;const schedule=()=>{clearTimeout(timer);if(!stopped&&!document.hidden)timer=setTimeout(check,delay);};const check=async()=>{if(busy||stopped||document.hidden)return;busy=true;try{const r=await fetch(f.getAttribute("action"),{method:"POST",body:new URLSearchParams(new FormData(f)),credentials:"same-origin",headers:{"x-zuse-github-approval":"check"}});if(!r.ok){if(r.status<500&&r.status!==429)stopped=true;delay=60000;return;}const result=await r.json();if(result.ready){stopped=true;location.assign(f.dataset.resume);return;}delay=Math.min(delay*2,60000);}catch{delay=60000;}finally{busy=false;schedule();}};document.addEventListener("visibilitychange",()=>{clearTimeout(timer);if(!document.hidden)check();});addEventListener("focus",check);schedule();})();`;
const APPROVAL_POLL_SCRIPT_SOURCE = `'sha256-${createHash("sha256").update(APPROVAL_POLL_SCRIPT).digest("base64")}'`;

export const githubChooserPageHeaders = {
	...INTEGRATION_PAGE_HEADERS,
	"referrer-policy": "strict-origin",
	"content-security-policy": `${INTEGRATION_PAGE_HEADERS["content-security-policy"]}; form-action 'self'`,
};
export const githubApprovalPageHeaders = {
	...githubChooserPageHeaders,
	"content-security-policy": `${githubChooserPageHeaders[
		"content-security-policy"
	].replace(
		"script-src ",
		`script-src ${APPROVAL_POLL_SCRIPT_SOURCE} `,
	)}; connect-src 'self'`,
};

export const renderGithubConnectedPage = (accountLogin: string): string => {
	const account = accountLogin.trim().slice(0, 80) || "Your GitHub account";
	// A bare zuse:// link can launch another checkout's app-less Electron on
	// macOS. Until the initiating desktop supplies an instance-specific return
	// URL, guide people back to their existing window.
	return renderIntegrationPage({
		integration: "GitHub",
		description: `${account} is connected to Zuse. You can close this tab.`,
		status: "Connected",
		hint: "Switch back to your open Zuse window and add a repository to continue. You can change repository access later in GitHub settings.",
		actions: [],
	});
};
export const githubCallbackPageHeaders = INTEGRATION_PAGE_HEADERS;

/** A GitHub-side installation or approval has no signed Zuse workspace state.
 * Guide the user back to an authenticated connection instead of guessing which
 * workspace should receive the installation. Query parameters are only hints;
 * this page never claims an installation or request succeeded. */
export const renderGithubSetupPage = (
	approvalRequested: boolean,
	resumeUrl?: string,
	approvalCheck?: { readonly callback: string; readonly state: string },
): string =>
	renderIntegrationPage({
		integration: "GitHub",
		title: approvalRequested
			? "Organization owner approval needed"
			: "Finish connecting GitHub",
		description: approvalRequested
			? "A GitHub organization owner must approve the app installation before it can be connected to your workspace."
			: "Installing or approving the GitHub app is one step. Connect it to a Zuse workspace to finish setup.",
		status: "Setup",
		hint: approvalRequested
			? "Your owner only needs GitHub. After approving the request, they can return to GitHub. Check approval here to connect the repositories you can write to. If this tab is no longer available, choose Connect GitHub again from the same Zuse workspace."
			: "If you approved this for someone else, tell them to check approval in their connection tab or choose Connect GitHub again in Zuse. You do not need a Zuse account. If you started setup yourself, open your workspace in Zuse and choose Connect GitHub.",
		actions: resumeUrl ? [{ label: "Check approval", href: resumeUrl }] : [],
	}).replace(
		"</body>",
		approvalCheck
			? `<form hidden data-approval-check action="${escapeHtml(approvalCheck.callback)}" data-resume="${escapeHtml(resumeUrl ?? "")}"><input name="csrf" value="${escapeHtml(approvalCheck.state)}"><input name="action" value="check-approval"></form><script>${APPROVAL_POLL_SCRIPT}</script></body>`
			: "</body>",
	);
