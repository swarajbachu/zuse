import type { ExtensionListItem, MarketplaceExtension } from "@zuse/contracts";
import { extensionInstallState } from "@zuse/extension-sdk";

export function visibleMarketplaceEntries(
	entries: readonly MarketplaceExtension[],
	installed: readonly Pick<
		ExtensionListItem,
		"id" | "manifest" | "activeCommit"
	>[],
	query: string,
): readonly MarketplaceExtension[] {
	const byId = new Map(installed.map((item) => [item.id, item]));
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return entries
		.filter((entry) => {
			const text = [
				entry.id,
				entry.manifest.name,
				entry.manifest.description,
				entry.manifest.publisher?.name,
				...entry.manifest.contributions,
			]
				.join(" ")
				.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		})
		.map((entry) => {
			const current = byId.get(entry.id);
			return {
				...entry,
				...extensionInstallState(
					{ version: entry.manifest.version, commit: entry.commit },
					current && {
						version: current.manifest.version,
						commit: current.activeCommit,
					},
				),
			};
		});
}
