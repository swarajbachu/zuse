import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";
import type { RuntimeMode } from "@zuse/contracts";

import { RUNTIME_OPTIONS } from "~/lib/model-options";
import { NEON_GREEN } from "~/theme";

const sf = (name: string) => name as never;

/** The composer "hand" button: a native menu of approval (runtime) modes. */
export function ComposerApprovalMenu({
	runtimeMode,
	onChange,
}: {
	runtimeMode: RuntimeMode;
	onChange: (mode: RuntimeMode) => void;
}) {
	return (
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label="" systemImage="checkmark.shield">
				{RUNTIME_OPTIONS.map((option) => (
					<NativeButton
						key={option.value}
						label={option.label}
						systemImage={
							runtimeMode === option.value ? sf("checkmark") : undefined
						}
						onPress={() => onChange(option.value)}
					/>
				))}
			</Menu>
		</Host>
	);
}
