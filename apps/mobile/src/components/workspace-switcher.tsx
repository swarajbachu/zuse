import { useAtomValue } from "@effect/atom-react";
import { workspaceScopeKey } from "@zuse/client-runtime/environment-scope";
import type { WorkspaceScope } from "@zuse/contracts";
import { useState } from "react";
import { Alert } from "react-native";
import { SelectorRow } from "~/components/selector-row";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	cloudCatalogAtom,
	refreshCloudOrganizations,
	selectCloudWorkspace,
} from "~/store/cloud-catalog";

export function WorkspaceSwitcher() {
	const catalog = useAtomValue(cloudCatalogAtom);
	const [busy, setBusy] = useState(false);
	const scope = catalog.scope;
	const organization =
		scope.kind === "organization"
			? catalog.organizations.find((entry) => entry.id === scope.organizationId)
			: undefined;
	const select = async (next: WorkspaceScope) => {
		if (busy) return;
		setBusy(true);
		try {
			await selectCloudWorkspace(next);
		} catch (cause) {
			Alert.alert("Couldn’t switch workspace", connectionErrorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const options = [
		{ scope: { kind: "personal" } as const, label: "Personal" },
		...catalog.organizations.map((entry) => ({
			scope: { kind: "organization", organizationId: entry.id } as const,
			label: entry.name,
		})),
	];
	return (
		<SelectorRow
			compact
			symbol={scope.kind === "personal" ? "person.crop.circle" : "person.2"}
			label={
				scope.kind === "personal"
					? "Personal"
					: (organization?.name ?? "Organization unavailable")
			}
			disabled={busy}
			emptyLabel="Switching…"
			options={[
				...options.map((entry) => ({
					key: workspaceScopeKey(entry.scope),
					label: entry.label,
					selected: workspaceScopeKey(entry.scope) === workspaceScopeKey(scope),
					onSelect: () => {
						void select(entry.scope);
					},
				})),
				{
					key: "refresh",
					label: "Refresh workspaces",
					selected: false,
					onSelect: () => {
						void refreshCloudOrganizations().catch((cause) =>
							Alert.alert(
								"Couldn’t load workspaces",
								connectionErrorMessage(cause),
							),
						);
					},
				},
			]}
		/>
	);
}
