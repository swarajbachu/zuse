import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";

import {
	type MobileReviewScope,
	REVIEW_SCOPES,
	reviewScopeLabel,
} from "~/lib/review-scope";
import { NEON_GREEN } from "~/theme";

export function ReviewScopeMenu({
	value,
	onChange,
}: {
	value: MobileReviewScope;
	onChange: (scope: MobileReviewScope) => void;
}) {
	return (
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label={reviewScopeLabel(value)}>
				{REVIEW_SCOPES.map((scope) => (
					<NativeButton
						key={scope}
						label={reviewScopeLabel(scope)}
						systemImage={scope === value ? "checkmark" : undefined}
						onPress={() => onChange(scope)}
					/>
				))}
			</Menu>
		</Host>
	);
}
