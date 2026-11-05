import type {
	AutomationDispatchInput,
	AutomationTrigger,
} from "@zuse/contracts";

type ExternalEvent = Pick<
	AutomationDispatchInput,
	"source" | "prompt" | "context"
>;

/** Match identically before cloud delivery and again before runtime execution. */
export const matchesAutomationEvent = (
	trigger: AutomationTrigger,
	event: ExternalEvent,
): boolean => {
	if (trigger._tag !== event.source) return false;
	if (trigger._tag === "github") {
		return (
			trigger.events.some((candidate) => candidate === event.context.event) &&
			(trigger.repositories.length === 0 ||
				trigger.repositories.some(
					(repository) =>
						repository.toLowerCase() ===
						(event.context.repository ?? "").toLowerCase(),
				)) &&
			(trigger.actions.length === 0 ||
				trigger.actions.includes(event.context.action ?? ""))
		);
	}
	if (trigger._tag === "slack") {
		return (
			trigger.events.some((kind) => kind === event.context.event) &&
			(trigger.channelIds.length === 0 ||
				trigger.channelIds.includes(event.context.channelId ?? "")) &&
			(trigger.includeBotMessages ||
				(!event.context.botId && event.context.bot !== "true")) &&
			(trigger.keywords.length === 0 ||
				trigger.keywords.some((word) =>
					(event.context.text ?? event.prompt)
						.toLowerCase()
						.includes(word.toLowerCase()),
				))
		);
	}
	return true;
};
