import type { AutomationConfig } from "@zuse/contracts";
import { automationPolicyIssues } from "@zuse/utils/automation-policy";
import { emailNotificationsConfigured } from "./notification.ts";

/** Never accept a restriction which the selected runtime cannot enforce. */
export function automationPolicyError(
	config: AutomationConfig,
	cloudMachines: boolean,
): string | null {
	return (
		automationPolicyIssues(config, {
			environment:
				process.env.ZUSE_RUNTIME_KIND === "cloud-workspace" ? "cloud" : "local",
			emailNotifications: emailNotificationsConfigured(),
			cloudMachines,
		})[0]?.message ?? null
	);
}
export { matchesAutomationEvent as matchesAutomationTrigger } from "@zuse/utils/automation-events";
