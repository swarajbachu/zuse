import { AUTOMATION_RESTRICTION_PROVIDERS } from "@zuse/utils/automation-policy";
import { emailNotificationsConfigured } from "./notification.ts";

export const automationCapabilities = (cloudMachines: boolean) => ({
	environment:
		process.env.ZUSE_RUNTIME_KIND === "cloud-workspace"
			? ("cloud" as const)
			: ("local" as const),
	networkIsolation: false,
	spendLimits: true,
	spendLimitProviders: AUTOMATION_RESTRICTION_PROVIDERS,
	mcpSelectionProviders: [],
	mcpSelection: false,
	systemIdentity: false,
	emailNotifications: emailNotificationsConfigured(),
	slackNotifications: process.env.ZUSE_RUNTIME_KIND === "cloud-workspace",
	cloudMachines,
});
