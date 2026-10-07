import "@zuse/i18n/english/settings";
import type {
	ReviewAvailability,
	ReviewConnection,
	ReviewSetup,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useRef, useState } from "react";
import { runCloudControl } from "../../lib/control-plane-client.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { CloudSettingsRow } from "./cloud-settings-ui.tsx";
import { DeviceCode } from "./connection-login-steps.tsx";
import { ReviewChoice } from "./review-choice.tsx";

export function ReviewNativeAccounts({
	setup,
	availability,
	busy,
	onAction,
}: {
	setup: ReviewSetup;
	availability: ReviewAvailability;
	busy: boolean;
	onAction: (operation: () => Promise<unknown>) => Promise<void>;
}) {
	const { message: m } = useMessages(["settings"]);
	const [label, setLabel] = useState("");
	const [providerId, setProviderId] = useState("");
	const [size, setSize] = useState("");
	const [callbackUrl, setCallbackUrl] = useState("");
	const [ack, setAck] = useState(false);
	const [current, setCurrent] = useState<ReviewConnection | null>(null);
	const [failed, setFailed] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (current?.state !== "authenticating") return;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const value = await runCloudControl((client) =>
					client["review.connection"]({ id: current.id }),
				);
				if (!active) return;
				setCurrent(value);
				if (value.state === "ready") void onAction(async () => {});
				else if (value.state === "authenticating")
					timer = setTimeout(poll, 3000);
			} catch {
				if (active) setFailed(true);
			}
		};
		timer = setTimeout(poll, 3000);
		return () => {
			active = false;
			if (timer) clearTimeout(timer);
		};
	}, [current?.id, current?.state, onAction]);
	const login = async (id: string) => {
		if (!window.confirm(m("settings:review_reconnect_confirm"))) return;
		await onAction(async () => {
			const value = await runCloudControl((client) =>
				client["review.connectionLogin"]({ id }),
			);
			if (mounted.current) {
				setCurrent(value);
				setFailed(false);
			}
		});
	};
	const placement = setup.placements.find(
		(item) => item.available && item.size === size,
	);
	const provider = availability.providers.find(
		(item) =>
			item.available &&
			item.provider === "claude" &&
			item.provider === providerId,
	);
	return (
		<div className="py-2">
			<details className="px-3 text-xs">
				<summary>{m("settings:review_accounts")}</summary>
				<p className="py-2 text-muted-foreground">
					{m("settings:review_accounts_detail")}
				</p>
				{setup.connections.map((connection) => (
					<CloudSettingsRow
						key={connection.id}
						title={connection.label}
						description={
							connection.available
								? m("settings:review_account_ready")
								: connection.reasons.join(" · ")
						}
						action={
							<div className="flex gap-1">
								<Button
									className="h-7"
									variant="ghost"
									disabled={
										busy ||
										!availability.providers.some(
											(item) =>
												item.available &&
												item.provider === connection.agentProvider,
										)
									}
									onClick={() => void login(connection.id)}
								>
									{m("settings:review_reconnect")}
								</Button>
								<Button
									className="h-7"
									variant="ghost"
									disabled={busy}
									onClick={() => {
										if (window.confirm(m("settings:review_revoke_confirm")))
											void onAction(async () => {
												await runCloudControl((client) =>
													client["review.connectionRevoke"]({
														id: connection.id,
													}),
												);
												if (mounted.current && current?.id === connection.id)
													setCurrent(null);
											});
									}}
								>
									{m("settings:review_revoke")}
								</Button>
							</div>
						}
					/>
				))}
				<ReviewChoice
					label={m("settings:review_login_provider")}
					value={providerId}
					options={availability.providers
						.filter((item) => item.provider === "claude")
						.map((item) => ({
							value: item.provider,
							label: item.provider,
							disabled: !item.available,
						}))}
					onChange={(value) => {
						setProviderId(value);
						setAck(false);
					}}
					disabled={busy}
				/>
				<ReviewChoice
					label={m("settings:review_login_size")}
					value={size}
					options={[
						...new Map(
							setup.placements
								.filter((item) => item.available)
								.map((item) => [
									item.size,
									{ value: item.size, label: item.size },
								]),
						).values(),
					]}
					onChange={(value) => {
						setSize(value);
						setAck(false);
					}}
					disabled={busy}
				/>
				<Input
					className="h-7"
					aria-label={m("settings:review_account_label")}
					value={label}
					onChange={(event) => setLabel(event.target.value)}
					placeholder={m("settings:review_account_label")}
					disabled={busy}
				/>
				<label className="my-2 flex items-start gap-2">
					<input
						type="checkbox"
						checked={ack}
						onChange={(event) => setAck(event.target.checked)}
						disabled={busy}
					/>
					{m("settings:review_login_charge")}
				</label>
				<Button
					className="h-7"
					disabled={busy || !provider || !placement || !label.trim() || !ack}
					onClick={() => {
						if (!provider || !placement) return;
						void onAction(async () => {
							const connection = await runCloudControl((client) =>
								client["review.connectionCreate"]({
									label: label.trim(),
									agentProvider: "claude",
									size: placement.size,
									acknowledgedCharges: true,
								}),
							);
							const value = await runCloudControl((client) =>
								client["review.connectionLogin"]({ id: connection.id }),
							);
							if (mounted.current) {
								setCurrent(value);
								setFailed(false);
								setAck(false);
							}
						});
					}}
				>
					{m("settings:review_connect_account")}
				</Button>
				{failed && (
					<p role="alert" className="py-2">
						{m("settings:review_error")}
					</p>
				)}
				{current && (
					<div className="space-y-2 py-2" role="status">
						<p>
							{current.label}: {m(`settings:review_account_${current.state}`)}
						</p>
						{current.reason && <p>{current.reason}</p>}
						{current.expiresAtMs && (
							<p>
								{m("settings:review_login_expires", {
									time: new Date(current.expiresAtMs).toLocaleString(),
								})}
							</p>
						)}
						{current.verificationUrl && (
							<Button
								className="h-7"
								onClick={() =>
									current.verificationUrl &&
									void openExternal(current.verificationUrl).catch(() =>
										setFailed(true),
									)
								}
							>
								{m("settings:review_open_login")}
							</Button>
						)}
						{current.state === "authenticating" && (
							<>
								<p>{m("settings:review_callback_detail")}</p>
								<Input
									className="h-7"
									aria-label={m("settings:review_callback_url")}
									autoComplete="off"
									value={callbackUrl}
									onChange={(event) => setCallbackUrl(event.target.value)}
									disabled={busy}
								/>
								<Button
									className="h-7"
									disabled={busy || !callbackUrl.trim()}
									onClick={() => {
										const url = callbackUrl;
										setCallbackUrl("");
										void onAction(async () => {
											const value = await runCloudControl((client) =>
												client["review.connectionComplete"]({
													id: current.id,
													callbackUrl: url,
												}),
											);
											if (mounted.current) setCurrent(value);
										});
									}}
								>
									{m("settings:review_complete_login")}
								</Button>
							</>
						)}
						{current.verificationCode && (
							<DeviceCode
								code={current.verificationCode}
								label={m("settings:review_copy_code")}
							/>
						)}
					</div>
				)}
			</details>
		</div>
	);
}
