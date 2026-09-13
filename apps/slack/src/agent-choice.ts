import {
	BUNDLED_MODEL_CATALOG,
	CloudAuthProvider,
	providerLabel,
	visibleModelsForProvider,
} from "@zuse/contracts";

// Use the shared cloud-provider contract and curated catalog, not a Slack-only model list.
const choices = CloudAuthProvider.literals
	.flatMap((agent) =>
		visibleModelsForProvider(BUNDLED_MODEL_CATALOG, agent).map((model) => ({
			agent,
			model: model.id,
			value: `${agent}:${model.id}`,
			label: `${providerLabel(agent)} — ${model.label}`,
		})),
	)
	.filter((choice) => choice.value.length <= 150)
	.slice(0, 100);

export const agentOptions = () =>
	choices.map((choice) => ({
		text: { type: "plain_text", text: choice.label.slice(0, 75) },
		value: choice.value,
	}));

export const resolveAgentChoice = (value: string | undefined) => {
	const choice = choices.find((candidate) => candidate.value === value);
	return choice ? { agent: choice.agent, model: choice.model } : undefined;
};
