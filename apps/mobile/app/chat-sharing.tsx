import { useAtomValue } from "@effect/atom-react";
import { fixedChatEditAccess } from "@zuse/client-runtime/chat-sharing";
import type { ChatSharingPolicy } from "@zuse/contracts";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ChatSharingOptions } from "~/components/chat-sharing-options";
import { SelectorRow } from "~/components/selector-row";
import { Button } from "~/components/ui/button";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { authAccountAtom } from "~/store/auth";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
} from "~/store/cloud-catalog";
import { createCloudChatSharingController } from "~/store/cloud-chat-sharing";

export default function ChatSharing() {
	const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
	const account = useAtomValue(authAccountAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const scope = catalog.scope;
	const summary = catalog.chats.find((row) => row.workspaceId === workspaceId);
	const allowed =
		mobileReleaseFeatures.organizationWorkspaces &&
		account !== null &&
		catalog.accountId === account.id &&
		scope.kind === "organization" &&
		summary?.workspaceScope?.kind === "organization" &&
		summary.workspaceScope.organizationId === scope.organizationId &&
		catalog.organizations.some(
			(entry) => entry.id === scope.organizationId && entry.role !== "billing",
		);
	return (
		<>
			<Stack.Screen options={{ title: "Share chat" }} />
			{allowed && workspaceId ? (
				<ShareContent
					key={`${cloudCatalogGeneration()}:${workspaceId}`}
					workspaceId={workspaceId}
				/>
			) : (
				<View className="flex-1 bg-background p-5">
					<Text className="text-muted-foreground">
						This chat is not available in the selected organization.
					</Text>
				</View>
			)}
		</>
	);
}

function ShareContent({ workspaceId }: { workspaceId: string }) {
	const [controller] = useState(() =>
		createCloudChatSharingController(workspaceId),
	);
	const [loaded, setLoaded] = useState<Awaited<
		ReturnType<typeof controller.load>
	> | null>(null);
	const [draft, setDraft] = useState<ChatSharingPolicy | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [copied, setCopied] = useState(false);
	const [reload, setReload] = useState(0);
	const active = useRef(false);
	const inFlight = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload retries a failed or conflicting sharing read.
	useEffect(() => {
		let live = true;
		active.current = true;
		setLoaded(null);
		setDraft(null);
		setError(false);
		setCopied(false);
		void controller
			.load()
			.then((value) => {
				if (live && controller.isCurrent()) {
					setLoaded(value);
					setDraft(value.sharing.policy);
				}
			})
			.catch(() => {
				if (live && controller.isCurrent()) setError(true);
			});
		return () => {
			live = false;
			active.current = false;
		};
	}, [controller, reload]);
	const current = () => active.current && controller.isCurrent();
	const save = async () => {
		if (
			!current() ||
			!loaded?.sharing.canManageSharing ||
			!draft ||
			inFlight.current
		)
			return;
		inFlight.current = true;
		setBusy(true);
		setError(false);
		try {
			const sharing = await controller.save({
				expectedRevision: loaded.sharing.revision,
				audience: draft.audience,
				permission: draft.permission,
				grants: draft.grants.filter((grant) =>
					loaded.organization.members.some(
						(member) =>
							member.id === grant.membershipId &&
							(member.role === "member" || member.role === "admin"),
					),
				),
			});
			if (current()) {
				setLoaded({ ...loaded, sharing });
				setDraft(sharing.policy);
			}
		} catch {
			if (current()) setError(true);
		} finally {
			inFlight.current = false;
			if (current()) setBusy(false);
		}
	};
	const copy = async () => {
		if (!current()) return;
		try {
			await Clipboard.setStringAsync(controller.link());
			if (current()) setCopied(true);
		} catch {
			if (current()) setError(true);
		}
	};
	const disabled = busy || !loaded?.sharing.canManageSharing;
	return (
		<ScrollView
			className="flex-1 bg-background"
			contentContainerClassName="gap-4 p-5"
		>
			{loaded && draft ? (
				<>
					<Text className="font-sans-bold text-lg text-foreground">
						{loaded.organization.organization.name}
					</Text>
					<ChatSharingOptions
						value={draft}
						organizationName={loaded.organization.organization.name}
						disabled={disabled}
						onChange={setDraft}
					/>
					<Text className="font-sans-medium text-foreground">
						People with access
					</Text>
					{loaded.organization.members
						.filter(
							(member) => member.role === "admin" || member.role === "member",
						)
						.map((member) => {
							const fixed = fixedChatEditAccess(draft, member);
							const grant = draft.grants.find(
								(entry) => entry.membershipId === member.id,
							);
							const inherited =
								draft.audience === "organization"
									? draft.permission === "edit"
										? "Organization · Edit"
										: "Organization · View"
									: "No access";
							return (
								<View key={member.id} className="gap-1">
									<Text className="text-foreground">{member.displayName}</Text>
									<Text className="text-sm text-muted-foreground">
										{member.email}
									</Text>
									{fixed ? (
										<Text className="text-sm text-muted-foreground">
											{fixed === "admin"
												? "Administrator · Edit"
												: fixed === "creator"
													? "Creator · Edit"
													: "Organization · Edit"}
										</Text>
									) : (
										<SelectorRow
											compact
											symbol="person"
											label={
												grant
													? `Invited · ${grant.permission === "edit" ? "Edit" : "View"}`
													: inherited
											}
											disabled={disabled}
											options={(["inherited", "view", "edit"] as const).map(
												(permission) => ({
													key: permission,
													label:
														permission === "inherited"
															? inherited
															: `Invited · ${permission === "edit" ? "Edit" : "View"}`,
													selected:
														permission === (grant?.permission ?? "inherited"),
													onSelect: () =>
														setDraft({
															...draft,
															grants: [
																...draft.grants.filter(
																	(entry) => entry.membershipId !== member.id,
																),
																...(permission === "inherited"
																	? []
																	: [{ membershipId: member.id, permission }]),
															],
														}),
												}),
											)}
										/>
									)}
								</View>
							);
						})}
					{loaded.sharing.canManageSharing ? (
						<Button
							className="h-7 self-start"
							size="sm"
							disabled={
								busy ||
								JSON.stringify(draft) === JSON.stringify(loaded.sharing.policy)
							}
							onPress={() => void save()}
						>
							{busy ? "Saving…" : "Save access"}
						</Button>
					) : null}
					<Button
						className="h-7 self-start"
						size="sm"
						variant="ghost"
						onPress={() => void copy()}
					>
						{copied ? "Copied" : "Copy link"}
					</Button>
				</>
			) : !error ? (
				<Text className="text-muted-foreground">Loading…</Text>
			) : null}
			<Text className="text-sm text-muted-foreground">
				Links require sign-in and do not grant access. Private chats remain
				accessible to their creator, invited members, and organization
				administrators. Organization access still applies when an individual
				grant is more restrictive.
			</Text>
			{error ? (
				<View className="gap-2">
					<Text accessibilityRole="alert" className="text-danger">
						Couldn’t load or save access. It may have changed. Refresh before
						retrying.
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
		</ScrollView>
	);
}
