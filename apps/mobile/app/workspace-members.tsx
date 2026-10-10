import { useAtomValue } from "@effect/atom-react";
import {
	ORGANIZATION_MEMBER_LIMIT,
	type OrganizationDetails,
	type OrganizationRole,
} from "@zuse/contracts";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { SelectorRow } from "~/components/selector-row";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { authAccountAtom } from "~/store/auth";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
} from "~/store/cloud-catalog";
import { createOrganizationMembersController } from "~/store/organization-members";

const roles = [
	{ key: "member", label: "Member" },
	{ key: "admin", label: "Administrator" },
	{ key: "billing", label: "Billing only" },
] as const;

function RoleSelect({
	value,
	disabled,
	onChange,
}: {
	value: string;
	disabled: boolean;
	onChange: (role: OrganizationRole) => void;
}) {
	return (
		<SelectorRow
			compact
			symbol="person.badge.key"
			label={roles.find((role) => role.key === value)?.label ?? value}
			disabled={disabled}
			emptyLabel="Please wait…"
			options={roles.map((role) => ({
				...role,
				selected: role.key === value,
				onSelect: () => onChange(role.key),
			}))}
		/>
	);
}

export default function WorkspaceMembers() {
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
		organization !== undefined;
	return (
		<>
			<Stack.Screen options={{ title: "Members" }} />
			{allowed ? (
				<MembersContent key={cloudCatalogGeneration()} />
			) : (
				<View className="flex-1 bg-background p-5">
					<Text className="text-muted-foreground">
						Select an organization you belong to to view its members.
					</Text>
				</View>
			)}
		</>
	);
}

function MembersContent() {
	const [controller] = useState(createOrganizationMembersController);
	const [details, setDetails] = useState<OrganizationDetails | null>(null);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<OrganizationRole>("member");
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const active = useRef(false);
	const inFlight = useRef(false);
	const current = () => active.current && controller.isCurrent();
	useEffect(() => {
		let live = true;
		active.current = true;
		void controller
			.load()
			.then((value) => {
				if (live && controller.isCurrent()) setDetails(value);
			})
			.catch(() => {
				if (live && controller.isCurrent())
					setError("Couldn’t load members. Try refreshing.");
			})
			.finally(() => {
				if (live && controller.isCurrent()) setBusy(false);
			});
		return () => {
			live = false;
			active.current = false;
		};
	}, [controller]);
	const run = async (operation?: () => Promise<unknown>, success?: string) => {
		if (!current() || inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		setNotice(null);
		// Remove stale role controls before refreshing or performing a mutation.
		setDetails(null);
		try {
			await operation?.();
			if (!current()) return;
			if (success) {
				setNotice(success);
				setEmail("");
			}
			const value = await controller.load();
			if (current()) setDetails(value);
		} catch {
			if (current())
				setError(
					"Couldn’t complete the request. Refresh to check current members and invitations before retrying.",
				);
		} finally {
			inFlight.current = false;
			if (current()) setBusy(false);
		}
	};
	const admin = details?.organization.role === "admin";
	const pending =
		details?.invitations.filter((invite) => invite.state === "pending") ?? [];
	const seats = (details?.members.length ?? 0) + pending.length;
	return (
		<ScrollView
			className="flex-1 bg-background"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="gap-5 p-5"
		>
			<View className="flex-row items-center justify-between gap-3">
				<Text className="flex-1 font-sans-bold text-lg text-foreground">
					{details?.organization.name ?? "Members"}
				</Text>
				<Button
					className="h-7"
					size="sm"
					variant="ghost"
					disabled={busy}
					onPress={() => void run()}
				>
					{busy ? "Loading…" : "Refresh"}
				</Button>
			</View>
			{notice ? (
				<Text accessibilityRole="alert" className="text-muted-foreground">
					{notice}
				</Text>
			) : null}
			{error ? (
				<Text accessibilityRole="alert" className="text-danger">
					{error}
				</Text>
			) : null}
			{details?.members.map((member) => (
				<View key={member.id} className="gap-1">
					<Text className="font-sans-medium text-foreground">
						{member.displayName}
						{member.userId === details.currentUserId ? " (you)" : ""}
					</Text>
					<Text className="text-sm text-muted-foreground">{member.email}</Text>
					{admin &&
					member.userId !== details.currentUserId &&
					!member.directoryManaged ? (
						<View className="flex-row items-center justify-between gap-2">
							<RoleSelect
								value={member.role}
								disabled={busy}
								onChange={(next) =>
									void run(() => controller.setRole(member.id, next))
								}
							/>
							<Button
								className="h-7"
								size="sm"
								variant="ghost"
								disabled={busy}
								onPress={() =>
									Alert.alert(
										"Remove member?",
										`${member.displayName} will lose access to ${details.organization.name}.`,
										[
											{ text: "Cancel", style: "cancel" },
											{
												text: "Remove",
												style: "destructive",
												onPress: () =>
													void run(() => controller.remove(member.id)),
											},
										],
									)
								}
							>
								Remove
							</Button>
						</View>
					) : (
						<Text className="text-sm text-muted-foreground">
							{member.directoryManaged
								? "Managed by directory"
								: (roles.find((role) => role.key === member.role)?.label ??
									member.role)}
						</Text>
					)}
				</View>
			))}
			{admin ? (
				<>
					<View className="gap-2">
						<Text className="font-sans-medium text-foreground">
							Invite a member · {seats}/{ORGANIZATION_MEMBER_LIMIT} seats
						</Text>
						<Text className="text-sm text-muted-foreground">
							Pending invitations and billing-only members count toward the
							limit. Billing-only access does not include chats, code, or
							secrets.
						</Text>
						<Input
							className="h-7 rounded-md border-0"
							accessibilityLabel="Invitation email"
							placeholder="Email address"
							keyboardType="email-address"
							autoCapitalize="none"
							autoCorrect={false}
							value={email}
							onChangeText={setEmail}
							editable={!busy && seats < ORGANIZATION_MEMBER_LIMIT}
						/>
						<View className="flex-row items-center justify-between gap-2">
							<RoleSelect
								value={role}
								disabled={busy || seats >= ORGANIZATION_MEMBER_LIMIT}
								onChange={setRole}
							/>
							<Button
								className="h-7"
								size="sm"
								disabled={
									busy || !email.trim() || seats >= ORGANIZATION_MEMBER_LIMIT
								}
								onPress={() =>
									void run(
										() => controller.invite(email.trim(), role),
										"Invitation sent.",
									)
								}
							>
								Send invitation
							</Button>
						</View>
					</View>
					{pending.length > 0 ? (
						<Text className="font-sans-medium text-foreground">
							Pending invitations
						</Text>
					) : null}
					{pending.map((invite) => (
						<View
							key={invite.id}
							className="flex-row items-center justify-between gap-2"
						>
							<Text className="flex-1 text-foreground">{invite.email}</Text>
							<Button
								className="h-7"
								size="sm"
								variant="ghost"
								disabled={busy}
								onPress={() =>
									Alert.alert(
										"Revoke invitation?",
										`Cancel the invitation for ${invite.email}?`,
										[
											{ text: "Cancel", style: "cancel" },
											{
												text: "Revoke",
												style: "destructive",
												onPress: () =>
													void run(() => controller.revoke(invite.id)),
											},
										],
									)
								}
							>
								Revoke
							</Button>
						</View>
					))}
				</>
			) : null}
		</ScrollView>
	);
}
