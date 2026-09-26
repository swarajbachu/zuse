import type { ExtensionAttachmentSnapshot } from "@zuse/extension-sdk";
import { lazy, Suspense } from "react";
import { useExtensionContributions } from "~/lib/extension-registry.tsx";

const Picker = lazy(() =>
	import("./extension-attachment-picker.tsx").then((module) => ({
		default: module.ExtensionAttachmentPicker,
	})),
);

/** Load the optional picker only when an enabled extension provides sources. */
export function ExtensionAttachmentAction({
	onSelect,
}: {
	onSelect: (snapshot: ExtensionAttachmentSnapshot) => Promise<void>;
}) {
	const extensions = useExtensionContributions();
	if (!extensions.some((entry) => entry.contributions.attachmentSources.length))
		return null;
	return (
		<Suspense fallback={null}>
			<Picker onSelect={onSelect} />
		</Suspense>
	);
}
