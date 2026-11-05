import { createHash } from "node:crypto";
import type {
	Automation,
	AutomationConfig,
	AutomationRun,
} from "@zuse/contracts";

type Notification = AutomationConfig["notifications"][number];
type MailEnvironment = Partial<
	Pick<
		NodeJS.ProcessEnv,
		"ZUSE_AUTOMATION_EMAIL_API_KEY" | "ZUSE_AUTOMATION_EMAIL_FROM"
	>
>;

export const emailNotificationsConfigured = (
	env: MailEnvironment = process.env,
): boolean =>
	Boolean(
		env.ZUSE_AUTOMATION_EMAIL_API_KEY?.trim() &&
			env.ZUSE_AUTOMATION_EMAIL_FROM?.trim(),
	);

/** The worker owns retries and persists an outbox; this adapter sends once. */
export const deliverAutomationNotification = async (
	input: {
		run: AutomationRun;
		automation: Automation;
		notification: Notification;
	},
	options: { env?: MailEnvironment; fetch?: typeof fetch } = {},
): Promise<void> => {
	const env = options.env ?? process.env;
	if (input.notification.channel !== "email")
		throw new Error(
			"Slack notifications require the connected cloud integration.",
		);
	if (!emailNotificationsConfigured(env))
		throw new Error(
			"Configure ZUSE_AUTOMATION_EMAIL_API_KEY and ZUSE_AUTOMATION_EMAIL_FROM to send email notifications.",
		);
	if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(input.notification.destination))
		throw new Error("Invalid email notification address.");
	if (!["completed", "failed", "cancelled"].includes(input.run.status))
		throw new Error("Notifications require a terminal run.");
	const key = createHash("sha256")
		.update(`${input.run.id}:${input.notification.destination}`)
		.digest("hex");
	const response = await (options.fetch ?? fetch)(
		"https://api.resend.com/emails",
		{
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: {
				Authorization: `Bearer ${env.ZUSE_AUTOMATION_EMAIL_API_KEY}`,
				"Content-Type": "application/json",
				"Idempotency-Key": `zuse-automation-${key}`,
			},
			body: JSON.stringify({
				from: env.ZUSE_AUTOMATION_EMAIL_FROM,
				to: [input.notification.destination],
				subject: `${input.automation.config.name.replace(/[\r\n]/gu, " ").slice(0, 150)}: ${input.run.status}`,
				text: [
					`Automation: ${input.automation.config.name}`,
					`Status: ${input.run.status}`,
					`Run: ${input.run.id}`,
					...(input.run.sessionId ? [`Session: ${input.run.sessionId}`] : []),
					...(input.run.error
						? [`Error: ${input.run.error.slice(0, 4000)}`]
						: []),
					"Open Zuse Automations to review the run and its session.",
				].join("\n"),
			}),
		},
	);
	// Do not persist response bodies: provider errors can echo credentials or addresses.
	if (!response.ok)
		throw new Error(
			`Email notification delivery failed (HTTP ${response.status}).`,
		);
	await response.body?.cancel();
};
