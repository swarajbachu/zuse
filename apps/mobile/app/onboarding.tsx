import { useLocalSearchParams } from "expo-router";

import { OnboardingFlow } from "~/components/onboarding/onboarding-flow";

export default function OnboardingScreen() {
	const { replay } = useLocalSearchParams<{ replay?: string }>();
	return <OnboardingFlow replay={replay === "1"} />;
}
