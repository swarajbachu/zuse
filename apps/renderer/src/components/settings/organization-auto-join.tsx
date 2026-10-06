import "@zuse/i18n/english/settings";
import { useMessages } from "@zuse/i18n/react";
import { useCallback, useEffect, useState } from "react";
import {
	type StillCurrent,
	useOrganizationAction,
} from "../../hooks/use-organization-action.ts";
import { connectGithub } from "../../lib/connect-github.ts";
import { runOrganizations } from "../../lib/organization-client.ts";
import { organizationErrorMessage } from "../../lib/organization-error.ts";
import {
	loadOrganizationAutoJoin,
	type OrganizationAutoJoinSettings,
	peekOrganizationAutoJoin,
} from "../../lib/organization-settings-cache.ts";
import { DitherActionButton } from "../ui/dither-action-button.tsx";
import {
	SettingsGroup,
	SettingsNote,
	SettingsRow,
} from "../ui/settings-panel.tsx";
import { Switch } from "../ui/switch.tsx";
import { OrganizationAvatar } from "./organization-avatar.tsx";

/** The DNS TXT record that proves domain ownership, and the check. */
function DomainVerification({
	name,
	value,
	busy,
	notFound,
	onVerify,
}: {
	name: string;
	value: string;
	busy: boolean;
	notFound: boolean;
	onVerify: () => void;
}) {
	const { message } = useMessages(["settings"]);
	const field = (label: string, text: string) => (
		<div className="flex min-w-0 items-baseline gap-2">
			<span className="w-10 shrink-0 text-[11px] text-muted-foreground">
				{label}
			</span>
			<code className="min-w-0 select-all break-all font-mono text-[11px] text-foreground">
				{text}
			</code>
		</div>
	);
	return (
		<div className="ms-9 flex flex-col gap-2">
			<div className="flex flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-2">
				{field(message("settings:organizations_domain_record_type"), "TXT")}
				{field(message("settings:organizations_domain_record_name"), name)}
				{field(message("settings:organizations_domain_record_value"), value)}
			</div>
			<div className="flex items-center gap-2">
				<DitherActionButton tone="secondary" disabled={busy} onClick={onVerify}>
					{message("settings:organizations_domain_verify")}
				</DitherActionButton>
				{notFound ? (
					<span role="status" className="text-[11px] text-muted-foreground">
						{message("settings:organizations_domain_not_found")}
					</span>
				) : null}
			</div>
		</div>
	);
}

/**
 * Admin controls for who joins this organization automatically: members of
 * linked GitHub organizations and people with a verified email on an owned
 * domain. Linking GitHub shares the installation with Cloud repositories.
 */
export function OrganizationAutoJoin({
	organizationId,
}: {
	organizationId: string;
}) {
	const { message } = useMessages(["settings"]);
	const { busy, error, setError, guard, run } = useOrganizationAction();
	// Open from the cached snapshot and revalidate in the background.
	const [unverified, setUnverified] = useState<string | null>(null);
	const [settings, setSettings] = useState<OrganizationAutoJoinSettings | null>(
		() => peekOrganizationAutoJoin(organizationId) ?? null,
	);

	const load = useCallback(
		async (current: StillCurrent) => {
			const next = await loadOrganizationAutoJoin(organizationId, true);
			if (current()) setSettings(next);
		},
		[organizationId],
	);

	useEffect(() => {
		const current = guard();
		const reload = () =>
			load(current).catch((cause) => {
				if (current()) setError(organizationErrorMessage(cause));
			});
		void reload();
		// Linking finishes in the browser; pick it up when Zuse regains focus.
		window.addEventListener("focus", reload);
		return () => window.removeEventListener("focus", reload);
	}, [guard, load, setError]);

	const update = (action: () => Promise<void>) =>
		void run(async (current) => {
			await action();
			if (current()) await load(current);
		});

	if (!settings && !error) return null;
	const blocked = [
		...(settings?.github.blockedMembers ?? []).map((member) => ({
			...member,
			key: `github:${member.accountId}`,
			restore: () =>
				runOrganizations((c) =>
					c["organizations.githubRestore"]({
						organizationId,
						accountId: member.accountId,
					}),
				),
		})),
		...(settings?.domains.blockedMembers ?? []).map((member) => ({
			...member,
			key: `domain:${member.accountId}`,
			restore: () =>
				runOrganizations((c) =>
					c["organizations.domainRestore"]({
						organizationId,
						accountId: member.accountId,
					}),
				),
		})),
	];
	// One switch per domain: on means verified emails there auto-join; the
	// admin's own unclaimed domain is offered switched off.
	const suggested = settings?.domains.suggestedDomain ?? null;
	const domainRows: ReadonlyArray<{
		readonly domain: string;
		readonly on: boolean;
		readonly verified: boolean;
		readonly recordName?: string;
		readonly recordValue?: string;
	}> = [
		...(settings?.domains.domains ?? []).map((claim) => ({
			...claim,
			on: true,
		})),
		...(suggested === null
			? []
			: [{ domain: suggested, on: false, verified: false }]),
	];
	return (
		<>
			<SettingsGroup
				title={message("settings:organizations_github_allow")}
				description={message("settings:organizations_github_allow_help")}
				action={
					<DitherActionButton
						tone="secondary"
						disabled={busy}
						onClick={() => void run(connectGithub)}
					>
						{message("settings:organizations_github_link")}
					</DitherActionButton>
				}
			>
				{error && <SettingsNote tone="error">{error}</SettingsNote>}
				{settings?.github.installations.length === 0 && (
					<SettingsRow
						title={message("settings:organizations_github_not_connected")}
						description={message("settings:organizations_github_connect_help")}
					/>
				)}
				{settings?.github.installations.map((installation) => (
					<SettingsRow
						key={installation.installationId}
						leading={
							<OrganizationAvatar
								seed={`github:${installation.login}`}
								imageUrl={installation.avatarUrl}
							/>
						}
						title={installation.login}
						description={message(
							installation.suspended
								? "settings:organizations_github_suspended"
								: installation.enabled
									? "settings:organizations_github_auto_join_on"
									: "settings:organizations_github_auto_join_off",
						)}
						action={
							<Switch
								aria-label={message(
									"settings:organizations_github_allow_installation",
									{ login: installation.login },
								)}
								checked={installation.enabled}
								disabled={busy || installation.suspended}
								onCheckedChange={(enabled) =>
									update(() =>
										runOrganizations((c) =>
											c["organizations.githubPolicy"]({
												organizationId,
												installationId: installation.installationId,
												enabled,
											}),
										),
									)
								}
							/>
						}
					/>
				))}
			</SettingsGroup>
			{settings && (
				<SettingsGroup
					title={message("settings:organizations_domains")}
					description={message("settings:organizations_domains_help")}
				>
					{domainRows.length === 0 && (
						<SettingsNote>
							{message("settings:organizations_domains_none")}
						</SettingsNote>
					)}
					{domainRows.map(
						({ domain, on, verified, recordName, recordValue }) => (
							<SettingsRow
								key={domain}
								leading={<OrganizationAvatar seed={`domain:${domain}`} />}
								title={`@${domain}`}
								description={message(
									!on
										? "settings:organizations_domain_add_help"
										: verified
											? "settings:organizations_domain_on_help"
											: "settings:organizations_domain_pending_help",
									{ domain },
								)}
								action={
									<Switch
										aria-label={message(
											"settings:organizations_domain_auto_join",
											{
												domain,
											},
										)}
										checked={on}
										disabled={busy}
										onCheckedChange={(next) =>
											update(() =>
												runOrganizations((c) =>
													c[
														next
															? "organizations.domainAdd"
															: "organizations.domainRemove"
													]({ organizationId, domain }),
												),
											)
										}
									/>
								}
							>
								{on && !verified && recordName && recordValue ? (
									<DomainVerification
										name={recordName}
										value={recordValue}
										busy={busy}
										notFound={unverified === domain}
										onVerify={() =>
											void run(async (current) => {
												setUnverified(null);
												const result = await runOrganizations((c) =>
													c["organizations.domainVerify"]({
														organizationId,
														domain,
													}),
												);
												if (!current()) return;
												if (!result.verified) setUnverified(domain);
												await load(current);
											})
										}
									/>
								) : null}
							</SettingsRow>
						),
					)}
				</SettingsGroup>
			)}
			{blocked.length > 0 && (
				<SettingsGroup
					title={message("settings:organizations_github_blocked_title")}
					description={message("settings:organizations_github_blocked")}
				>
					{blocked.map((member) => (
						<SettingsRow
							key={member.key}
							leading={<OrganizationAvatar seed={member.accountId} />}
							title={member.displayName}
							action={
								<DitherActionButton
									tone="secondary"
									disabled={busy}
									onClick={() => update(member.restore)}
								>
									{message("settings:organizations_github_restore")}
								</DitherActionButton>
							}
						/>
					))}
				</SettingsGroup>
			)}
		</>
	);
}
