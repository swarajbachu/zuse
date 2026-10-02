import { useAtomValue } from "@effect/atom-react";
import { Effect } from "effect";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { WorkspaceSwitcher } from "~/components/workspace-switcher";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { cloudControlClientForWorkspace } from "~/rpc/api-client";
import { authAccountAtom } from "~/store/auth";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
	cloudWorkspaceSnapshot,
} from "~/store/cloud-catalog";

/** Finance members never mount the chat home or acquire runtime connections. */
export function WorkspaceBilling() {
	const account = useAtomValue(authAccountAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const scope = catalog.scope;
	const organization =
		scope.kind === "organization"
			? catalog.organizations.find((entry) => entry.id === scope.organizationId)
			: undefined;
	const allowed =
		account !== null &&
		account.id === catalog.accountId &&
		(scope.kind === "personal" ||
			(mobileReleaseFeatures.organizationWorkspaces &&
				(organization?.role === "admin" || organization?.role === "billing")));
	if (!allowed)
		return (
			<View className="flex-1 bg-background p-5">
				<Stack.Screen options={{ title: "Billing" }} />
				<Text className="text-muted-foreground">
					Sign in with workspace billing access to manage payment details.
				</Text>
			</View>
		);
	return (
		<WorkspaceBillingContent
			key={cloudCatalogGeneration()}
			name={
				scope.kind === "personal"
					? "Personal"
					: (organization?.name ?? "Organization")
			}
			billingOnly={organization?.role === "billing"}
		/>
	);
}

function WorkspaceBillingContent({
	name,
	billingOnly,
}: {
	name: string;
	billingOnly: boolean;
}) {
	const [snapshot] = useState(cloudWorkspaceSnapshot);
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isCurrent = () => active.current && snapshot.isCurrent();
	const openPortal = async () => {
		if (busy || !isCurrent()) return;
		setBusy(true);
		setError(null);
		try {
			const result = await Effect.runPromise(
				cloudControlClientForWorkspace(snapshot.scope)[
					"machines.billingPortal"
				](),
			);
			if (!isCurrent()) return;
			await Linking.openURL(result.portalUrl);
		} catch (cause) {
			if (isCurrent()) setError(connectionErrorMessage(cause));
		} finally {
			if (isCurrent()) setBusy(false);
		}
	};
	return (
		<View className="flex-1 gap-4 bg-background px-5 pt-6">
			<Stack.Screen
				options={{
					title: "Billing",
					headerTitle: mobileReleaseFeatures.organizationWorkspaces
						? () => <WorkspaceSwitcher />
						: undefined,
					headerRight: () => null,
				}}
			/>
			<Text className="font-sans-bold text-xl text-foreground">
				{name} billing
			</Text>
			<Text className="font-sans text-muted-foreground">
				Manage payment details and invoices for this workspace. Its subscription
				and balance are separate from other workspaces.
				{billingOnly
					? " Your billing-only membership does not grant access to chats, code, or secrets."
					: ""}
			</Text>
			<Button
				className="h-7 self-start"
				size="sm"
				disabled={busy}
				onPress={openPortal}
			>
				{busy ? "Opening…" : "Manage billing"}
			</Button>
			{error !== null ? (
				<Text accessibilityRole="alert" className="text-danger">
					{error}
				</Text>
			) : null}
		</View>
	);
}
