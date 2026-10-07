import "@zuse/i18n/english/settings";
import type { ReviewAvailability, ReviewSetup } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";
import { runCloudControl } from "../../lib/control-plane-client.ts";
import { useUiStore } from "../../store/ui.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";
import { ReviewChoice } from "./review-choice.tsx";
import { ReviewNativeAccounts } from "./review-native-accounts.tsx";

export function ReviewSetupForm({
	availability,
	busy,
	onAction,
}: {
	availability: ReviewAvailability;
	busy: boolean;
	onAction: (operation: () => Promise<unknown>) => Promise<void>;
}) {
	const { message: m } = useMessages(["settings"]);
	const [setup, setSetup] = useState<ReviewSetup | null>(null);
	const [failed, setFailed] = useState(false);
	const [repository, setRepository] = useState("");
	const [kind, setKind] = useState("personal");
	const [connectionId, setConnectionId] = useState("");
	const [model, setModel] = useState("");
	const [placementKey, setPlacementKey] = useState("");
	const [minutes, setMinutes] = useState("10");
	const [dollars, setDollars] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	useEffect(() => {
		let current = true;
		setFailed(false);
		void runCloudControl((client) => client["review.setup"]()).then(
			(value) => {
				if (current) setSetup(value);
			},
			() => {
				if (current) setFailed(true);
			},
		);
		return () => {
			current = false;
		};
	}, [availability]);
	const repo = setup?.repositories.find(
		(item) => String(item.id) === repository,
	);
	const connection = setup?.connections.find(
		(item) => item.id === connectionId,
	);
	const placement = setup?.placements.find(
		(item) => `${item.provider}:${item.size}` === placementKey,
	);
	const runtime = Number(minutes) * 60_000;
	const cost =
		dollars.trim() === "" ? undefined : Math.round(Number(dollars) * 1_000_000);
	const valid =
		availability.available &&
		repo &&
		(kind === "personal" || repo.canAdminister) &&
		connection?.available &&
		connection.models.includes(model) &&
		placement?.available &&
		acknowledged &&
		Number.isInteger(runtime) &&
		runtime >= 60_000 &&
		runtime <= 600_000 &&
		(cost === undefined || (Number.isSafeInteger(cost) && cost > 0));
	const change = (setter: (value: string) => void) => (value: string) => {
		setter(value);
		setAcknowledged(false);
	};
	return (
		<CloudSettingsGroup
			title={m("settings:review_setup")}
			description={m("settings:review_setup_detail")}
		>
			{failed ? (
				<p role="alert" className="px-3 py-2 text-xs">
					{m("settings:review_error")}
				</p>
			) : !setup ? (
				<p role="status" className="px-3 py-2 text-xs">
					{m("settings:review_loading")}
				</p>
			) : (
				<>
					{!setup.identity && (
						<CloudSettingsRow
							title={m("settings:review_connect_github")}
							description={m("settings:review_connect_github_detail")}
							action={
								<Button
									className="h-7"
									onClick={() =>
										useUiStore
											.getState()
											.setSettingsSection({ kind: "general" })
									}
								>
									{m("settings:review_account_settings")}
								</Button>
							}
						/>
					)}
					<ReviewNativeAccounts
						setup={setup}
						availability={availability}
						busy={busy}
						onAction={onAction}
					/>
					<ReviewChoice
						label={m("settings:review_repository")}
						value={repository}
						options={setup.repositories.map((item) => ({
							value: String(item.id),
							label: item.fullName,
						}))}
						onChange={(value) => {
							change(setRepository)(value);
							setKind("personal");
						}}
						disabled={busy}
					/>
					<ReviewChoice
						label={m("settings:review_coverage")}
						value={kind}
						options={[
							{ value: "personal", label: m("settings:review_personal") },
							{
								value: "shared",
								label: m("settings:review_shared"),
								disabled: !repo?.canAdminister,
							},
						]}
						onChange={change(setKind)}
						disabled={busy}
					/>
					<ReviewChoice
						label={m("settings:review_agent")}
						value={connectionId}
						options={setup.connections.map((item) => ({
							value: item.id,
							label: item.label,
							disabled: !item.available,
						}))}
						onChange={(value) => {
							change(setConnectionId)(value);
							setModel("");
						}}
						disabled={busy}
					/>
					<ReviewChoice
						label={m("settings:review_model")}
						value={model}
						options={(connection?.models ?? []).map((value) => ({
							value,
							label: value,
						}))}
						onChange={change(setModel)}
						disabled={busy}
					/>
					<ReviewChoice
						label={m("settings:review_worker")}
						value={placementKey}
						options={setup.placements.map((item) => ({
							value: `${item.provider}:${item.size}`,
							label: item.label,
							disabled: !item.available,
						}))}
						onChange={change(setPlacementKey)}
						disabled={busy}
					/>
					<CloudSettingsRow
						title={m("settings:review_payer")}
						description={setup.payer.label}
					/>
					<CloudSettingsRow
						title={m("settings:review_runtime_limit")}
						action={
							<Input
								className="h-7 w-24"
								aria-label={m("settings:review_runtime_limit")}
								type="number"
								min={1}
								max={10}
								value={minutes}
								onChange={(event) => change(setMinutes)(event.target.value)}
								disabled={busy}
							/>
						}
					/>
					<CloudSettingsRow
						title={m("settings:review_cost_limit")}
						action={
							<Input
								className="h-7 w-24"
								aria-label={m("settings:review_cost_limit")}
								type="number"
								min={0.000001}
								step="any"
								placeholder={m("settings:review_optional")}
								value={dollars}
								onChange={(event) => change(setDollars)(event.target.value)}
								disabled={busy}
							/>
						}
					/>
					{placement && (
						<p className="px-3 py-2 text-xs">
							{m("settings:review_estimate", {
								amount: (placement.estimatedMaxCostMicros / 1_000_000).toFixed(
									4,
								),
							})}
						</p>
					)}
					{setup.connections
						.filter((item) => !item.available)
						.map((item) => (
							<p
								key={item.id}
								className="px-3 py-2 text-xs text-muted-foreground"
							>
								{item.label}: {item.reasons.join(" · ")}
							</p>
						))}
					{setup.placements
						.filter((item) => !item.available)
						.map((item) => (
							<p
								key={`${item.provider}:${item.size}`}
								className="px-3 py-2 text-xs text-muted-foreground"
							>
								{item.label}: {item.reasons.join(" · ")}
							</p>
						))}
					{setup.connections.length === 0 && (
						<p role="status" className="px-3 py-2 text-xs">
							{m("settings:review_no_connections")}
						</p>
					)}
					{!availability.available && (
						<p role="status" className="px-3 py-2 text-xs">
							{m("settings:review_unavailable_detail")}
						</p>
					)}
					<div className="space-y-2 px-3 py-2 text-xs">
						<label className="flex items-start gap-2">
							<input
								type="checkbox"
								checked={acknowledged}
								disabled={busy}
								onChange={(event) => setAcknowledged(event.target.checked)}
							/>
							<span>{m("settings:review_spending_ack")}</span>
						</label>
						<Button
							className="h-7"
							disabled={busy || !valid}
							onClick={() => {
								if (!valid || !connection || !placement || !repo) return;
								void onAction(() =>
									runCloudControl((client) =>
										client["review.enroll"]({
											acknowledgedCharges: true,
											repositoryId: repo.id,
											kind: kind === "shared" ? "shared" : "personal",
											modelConnectionId: connection.id,
											agentProvider: connection.agentProvider,
											model,
											worker: {
												provider: placement.provider,
												size: placement.size,
												maxRuntimeMs: runtime,
												...(cost === undefined ? {} : { maxCostMicros: cost }),
											},
										}),
									),
								).then(() => setAcknowledged(false));
							}}
						>
							{m("settings:review_setup")}
						</Button>
						<p className="text-muted-foreground">
							{m("settings:review_no_backfill")}
						</p>
					</div>
				</>
			)}
		</CloudSettingsGroup>
	);
}

export function ReviewRequestForm({
	availability,
	busy,
	onAction,
}: {
	availability: ReviewAvailability;
	busy: boolean;
	onAction: (operation: () => Promise<unknown>) => Promise<void>;
}) {
	const { message: m } = useMessages(["settings"]);
	const [repository, setRepository] = useState("");
	const [pull, setPull] = useState("");
	const [head, setHead] = useState("");
	const [approveFork, setApproveFork] = useState(false);
	const enrolled = availability.enrollments.filter((item) => item.enabled);
	const options = [
		...new Map(enrolled.map((item) => [item.repositoryId, item])).values(),
	];
	const pullNumber = Number(pull);
	return (
		<CloudSettingsGroup
			title={m("settings:review_request")}
			description={m("settings:review_request_detail")}
		>
			<ReviewChoice
				label={m("settings:review_repository")}
				value={repository}
				options={options.map((item) => ({
					value: String(item.repositoryId),
					label: item.repositoryFullName,
				}))}
				onChange={(value) => {
					setRepository(value);
					setHead("");
					setApproveFork(false);
				}}
				disabled={busy}
			/>
			<CloudSettingsRow
				title={m("settings:review_pull_number")}
				action={
					<Input
						className="h-7 w-24"
						aria-label={m("settings:review_pull_number")}
						type="number"
						min={1}
						value={pull}
						onChange={(event) => {
							setPull(event.target.value);
							setHead("");
							setApproveFork(false);
						}}
						disabled={busy}
					/>
				}
			/>
			<details className="px-3 py-2 text-xs">
				<summary>{m("settings:review_fork_approval")}</summary>
				<p className="py-2 text-muted-foreground">
					{m("settings:review_fork_detail")}
				</p>
				<Input
					className="h-7"
					aria-label={m("settings:review_head_sha")}
					value={head}
					onChange={(event) => {
						setHead(event.target.value.trim());
						setApproveFork(false);
					}}
					disabled={busy}
				/>
				<label className="mt-2 flex items-start gap-2">
					<input
						type="checkbox"
						checked={approveFork}
						disabled={busy || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head)}
						onChange={(event) => setApproveFork(event.target.checked)}
					/>
					{m("settings:review_fork_ack")}
				</label>
			</details>
			<div className="px-3 py-2">
				<Button
					className="h-7"
					disabled={
						busy ||
						!availability.available ||
						!options.some((item) => String(item.repositoryId) === repository) ||
						!Number.isSafeInteger(pullNumber) ||
						pullNumber < 1 ||
						(head !== "" && !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
					}
					onClick={() => {
						if (window.confirm(m("settings:review_retry_confirm")))
							void onAction(() =>
								runCloudControl((client) =>
									client["review.request"]({
										repositoryId: Number(repository),
										pullNumber,
										...(head ? { expectedHeadSha: head, approveFork } : {}),
									}),
								),
							);
					}}
				>
					{m("settings:review_request")}
				</Button>
			</div>
		</CloudSettingsGroup>
	);
}
