import { Alert, Pressable, Text } from "react-native";

import {
	type MobileReviewScope,
	REVIEW_SCOPES,
	reviewScopeLabel,
} from "~/lib/review-scope";

export function ReviewScopeMenu({
	value,
	onChange,
}: {
	value: MobileReviewScope;
	onChange: (scope: MobileReviewScope) => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`Review range: ${reviewScopeLabel(value)}`}
			className="min-h-11 justify-center px-3"
			onPress={() =>
				Alert.alert(
					"Review range",
					undefined,
					REVIEW_SCOPES.map((scope) => ({
						text: reviewScopeLabel(scope),
						onPress: () => onChange(scope),
					})),
				)
			}
		>
			<Text className="font-sans-medium text-[15px] text-foreground">
				{reviewScopeLabel(value)}⌄
			</Text>
		</Pressable>
	);
}
