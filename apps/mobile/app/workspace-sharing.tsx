import { useAtomValue } from "@effect/atom-react";
import type { ChatSharingDefaults } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { ChatSharingOptions } from "~/components/chat-sharing-options";
import { Button } from "~/components/ui/button";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { cloudControlClientForWorkspace } from "~/rpc/api-client";
import { authAccountAtom } from "~/store/auth";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
	cloudWorkspaceAdminSnapshot,
} from "~/store/cloud-catalog";

export default function WorkspaceSharing() {
	const account = useAtomValue(authAccountAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const scope = catalog.scope;
	const organization =
		scope.kind === "organization"
			? catalog.organizations.find((entry) => entry.id === scope.organizationId)
			: undefined;
	const allowed =
		mobileReleaseFeatures.organizationWorkspaces &&
		account !== null &&
		account.id === catalog.accountId &&
		organization?.role === "admin";
	return (
		<>
			<Stack.Screen options={{ title: "Sharing defaults" }} />
			{allowed ? (
				<SharingDefaults
					key={cloudCatalogGeneration()}
					organizationName={organization.name}
				/>
			) : (
				<View className="flex-1 bg-background p-5">
					<Text className="text-muted-foreground">
						Organization administrators can manage sharing defaults.
					</Text>
				</View>
			)}
		</>
	);
}

function SharingDefaults({ organizationName }: { organizationName: string }) {
	const [snapshot] = useState(cloudWorkspaceAdminSnapshot);
	const [saved, setSaved] = useState<ChatSharingDefaults | null>(null);
	const [draft, setDraft] = useState<ChatSharingDefaults | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [reload, setReload] = useState(0);
	const active = useRef(false);
	const inFlight = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly retries a failed read.
	useEffect(() => {
		let live = true;
		active.current = true;
		setDraft(null);
		setSaved(null);
		setError(false);
		if (snapshot.isCurrent())
			void Effect.runPromise(
				cloudControlClientForWorkspace(snapshot.scope)[
					"cloud.sharing.defaults.get"
				](),
			)
				.then((value) => {
					if (live && snapshot.isCurrent()) {
						setSaved(value);
						setDraft(value);
					}
				})
				.catch(() => {
					if (live && snapshot.isCurrent()) setError(true);
				});
		return () => {
			live = false;
			active.current = false;
		};
	}, [snapshot, reload]);
	const save = async () => {
		if (!active.current || !snapshot.isCurrent() || !draft || inFlight.current)
			return;
		inFlight.current = true;
		setBusy(true);
		setError(false);
		try {
			const result = await Effect.runPromise(
				cloudControlClientForWorkspace(snapshot.scope)[
					"cloud.sharing.defaults.update"
				](draft),
			);
			if (active.current && snapshot.isCurrent()) {
				setSaved(result);
				setDraft(result);
			}
		} catch {
			if (active.current && snapshot.isCurrent()) setError(true);
		} finally {
			inFlight.current = false;
			if (active.current && snapshot.isCurrent()) setBusy(false);
		}
	};
	return (
		<View className="flex-1 gap-4 bg-background p-5">
			<Text className="font-sans-bold text-lg text-foreground">
				{organizationName}
			</Text>
			<Text className="text-muted-foreground">
				Default access for new chats. Existing chats keep their sharing
				settings.
			</Text>
			{draft ? (
				<>
					<ChatSharingOptions
						value={draft}
						organizationName={organizationName}
						disabled={busy}
						onChange={setDraft}
					/>
					<Button
						className="h-7 self-start"
						size="sm"
						disabled={
							busy ||
							(saved?.audience === draft.audience &&
								saved.permission === draft.permission)
						}
						onPress={() => void save()}
					>
						{busy ? "Saving…" : "Save defaults"}
					</Button>
				</>
			) : !error ? (
				<Text className="text-muted-foreground">Loading…</Text>
			) : null}
			<Text className="text-sm text-muted-foreground">
				Private chats are accessible to their creator, invited members, and
				organization administrators. View allows reading; Edit also allows
				workspace changes and agent interaction.
			</Text>
			{error ? (
				<View className="gap-2">
					<Text accessibilityRole="alert" className="text-danger">
						Couldn’t load or save sharing defaults. Refresh to check the current
						settings.
					</Text>
					<Button
						className="h-7 self-start"
						size="sm"
						variant="ghost"
						disabled={busy}
						onPress={() => setReload((value) => value + 1)}
					>
						Refresh
					</Button>
				</View>
			) : null}
		</View>
	);
}
