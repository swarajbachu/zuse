import "@zuse/i18n/english/settings";
import { useMessages } from "@zuse/i18n/react";
import { GithubIcon } from "@zuse/icons/solid-rounded";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrganizationAction } from "../../hooks/use-organization-action.ts";
import { runOrganizations } from "../../lib/organization-client.ts";
import { organizationErrorMessage } from "../../lib/organization-error.ts";
import { loadOrganizationWorkspaces } from "../../lib/organization-workspaces.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { DitherActionButton } from "../ui/dither-action-button.tsx";
import { SettingsNote, SettingsRow } from "../ui/settings-panel.tsx";

type Connection = { readonly connected: boolean; readonly login?: string };

/**
 * The GitHub account linked to this Zuse account for auto-join. Linking goes
 * through Zuse's GitHub App, so it may differ from the sign-in email.
 */
export function AccountGithubConnection() {
	const { message } = useMessages(["settings"]);
	const { busy, error, setError, guard, run } = useOrganizationAction();
	const [connection, setConnection] = useState<Connection | null>(null);
	const [waiting, setWaiting] = useState(false);
	const linkedLogin = useRef<string | undefined>(undefined);

	const load = useCallback(async () => {
		const current = guard();
		try {
			const next = await runOrganizations((c) =>
				c["organizations.githubConnection"]({}),
			);
			if (!current()) return;
			// Linking happens in the browser; organizations joined there show up now.
			if (next.login !== undefined && next.login !== linkedLogin.current)
				void loadOrganizationWorkspaces(true).catch(() => undefined);
			linkedLogin.current = next.login;
			setConnection(next);
		} catch (cause) {
			if (current()) setError(organizationErrorMessage(cause));
		}
	}, [guard, setError]);

	useEffect(() => {
		void load();
		const reload = () => void load();
		window.addEventListener("focus", reload);
		return () => window.removeEventListener("focus", reload);
	}, [load]);

	const connect = () =>
		run(async (current) => {
			await openExternal(async () => {
				const auth = await runOrganizations((c) =>
					c["organizations.githubAuthorize"]({}),
				);
				if (!current()) throw new Error("account_changed");
				return auth.url;
			});
			if (current()) setWaiting(true);
		});

	const linked = connection?.connected === true;
	return (
		<>
			<SettingsRow
				icon={GithubIcon}
				title={
					linked && connection.login
						? message("settings:account_github_connected_as", {
								login: connection.login,
							})
						: message("settings:account_github")
				}
				description={message(
					linked
						? "settings:account_github_connected_help"
						: waiting
							? "settings:account_github_waiting"
							: "settings:account_github_help",
				)}
				action={
					connection === null ? undefined : (
						<DitherActionButton
							tone={linked ? "secondary" : "primary"}
							loading={busy}
							onClick={() => void connect()}
						>
							{message(
								linked
									? "settings:account_github_change"
									: "settings:account_github_connect",
							)}
						</DitherActionButton>
					)
				}
			/>
			{error && <SettingsNote tone="error">{error}</SettingsNote>}
		</>
	);
}
