import {
	BUNDLED_MODEL_CATALOG,
	CloudAuthProvider,
	defaultModelFor,
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

export const agentOptions = (available?: readonly string[]) =>
	choices
		.filter(
			(choice) => available === undefined || available.includes(choice.agent),
		)
		.map((choice) => ({
			text: { type: "plain_text", text: choice.label.slice(0, 75) },
			value: choice.value,
		}));

export const resolveAgentChoice = (value: string | undefined) => {
	const choice = choices.find((candidate) => candidate.value === value);
	return choice ? { agent: choice.agent, model: choice.model } : undefined;
};

export const agentSettingOptions = (available?: readonly string[]) =>
	CloudAuthProvider.literals
		.filter((agent) => available === undefined || available.includes(agent))
		.map((agent) => ({
			value: agent,
			text: { type: "plain_text", text: providerLabel(agent).slice(0, 75) },
		}));

export const modelSettingOptions = (agent: string) => {
	const provider = CloudAuthProvider.literals.find(
		(candidate) => candidate === agent,
	);
	return provider
		? visibleModelsForProvider(BUNDLED_MODEL_CATALOG, provider)
				.filter((model) => model.id.length <= 150)
				.slice(0, 100)
				.map((model) => ({
					value: model.id,
					text: { type: "plain_text", text: model.label.slice(0, 75) },
				}))
		: [];
};
export const defaultAgentModel = (agent: string) => {
	const provider = CloudAuthProvider.literals.find(
		(candidate) => candidate === agent,
	);
	return provider
		? defaultModelFor(BUNDLED_MODEL_CATALOG, provider)
		: undefined;
};
