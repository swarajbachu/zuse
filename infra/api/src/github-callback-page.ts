import {
	INTEGRATION_PAGE_HEADERS,
	renderIntegrationPage,
} from "@zuse/utils/integration-page";

export const renderGithubConnectedPage = (accountLogin: string): string => {
	const account = accountLogin.trim().slice(0, 80) || "Your GitHub account";
	return renderIntegrationPage({
		integration: "GitHub",
		description: `${account} is connected to Zuse. You can close this tab.`,
		status: "Connected",
		hint: "Return to Zuse and add a repository to continue. You can change repository access later in GitHub settings.",
		actions: [{ label: "Open Zuse", href: "zuse://" }],
	});
};
export const githubCallbackPageHeaders = INTEGRATION_PAGE_HEADERS;
