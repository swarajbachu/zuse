import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import { renderIntegrationPage } from "@zuse/utils/integration-page";

export const renderGithubConnectedPage = (
	accountLogin: string,
	nowMs = Date.now(),
): string => {
	const account = accountLogin.trim().slice(0, 80) || "Your GitHub account";
	return renderIntegrationPage({
		integration: "GitHub",
		description: `${account} is connected to Zuse. You can close this tab.`,
		status: "Connected",
		hint: "Zuse already picked this up — there is nothing else to do here.",
		actions: [{ label: "Open Zuse", href: "zuse://" }],
		nowMs,
	});
};
export const githubCallbackPageHeaders = BROWSER_PAGE_HEADERS;
