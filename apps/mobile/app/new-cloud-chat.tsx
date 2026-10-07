import { useAtomValue } from "@effect/atom-react";
import {
	cloudProviderLabel,
	orderedCloudProviders,
	selectedCloudProvider,
} from "@zuse/client-runtime/cloud-sandbox-providers";
import {
	DEFAULT_RUNTIME_MODE,
	defaultModelFor,
	type ProviderId,
	providerLabel,
	type RuntimeMode,
} from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { SelectorRow } from "~/components/selector-row";
import { Button } from "~/components/ui/button";
import { cloudSandboxStatus } from "~/lib/cloud-sandbox-setup";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { modelOptionsForProvider, RUNTIME_OPTIONS } from "~/lib/model-options";
import { cloudControlClient } from "~/rpc/api-client";
import { authAccountAtom, signIn } from "~/store/auth";
import {
	cloudAuthenticatedProvidersAtom,
	cloudCatalogAtom,
	refreshCloudCatalog,
} from "~/store/cloud-catalog";
import { launchMobileCloudChat } from "~/store/cloud-launch";
import {
	composerDraft,
	hydrateComposerDraft,
	setComposerDraft,
} from "~/store/composer-drafts";

import { activeModelCatalogAtom } from "~/store/model-catalog";

export default function NewCloudChatScreen() {
	const modelCatalog = useAtomValue(activeModelCatalogAtom);
	const account = useAtomValue(authAccountAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const providers = useAtomValue(cloudAuthenticatedProvidersAtom);
	const params = useLocalSearchParams<{
		draft?: string;
		projectId?: string;
		sandbox?: string;
	}>();
	const draftKey = `new-cloud:${account?.id ?? "signed-out"}`;
	const [text, setText] = useState(
		params.draft ?? composerDraft(draftKey).text,
	);
	const [projectId, setProjectId] = useState(params.projectId);
	const [sandbox, setSandbox] = useState<string | null>(params.sandbox ?? null);
	const sandboxProviders = orderedCloudProviders(catalog.providers);
	const [agent, setAgent] = useState<ProviderId | null>(null);
	const [model, setModel] = useState<string | null>(null);
	const [runtimeMode, setRuntimeMode] =
		useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
	const [busy, setBusy] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submitting = useRef(false);
	const completed = useRef(false);
	const project =
		catalog.projects.find((row) => row.projectId === projectId) ??
		catalog.projects[0];
	// Prefer a provider whose image is ready for this repository, as desktop does.
	const sandboxProvider =
		selectedCloudProvider(
			catalog.providers,
			sandbox ?? catalog.image?.providerId ?? null,
			catalog.providers
				.filter(
					(row) =>
						cloudSandboxStatus(
							catalog,
							row.providerId,
							project?.projectId ?? null,
						).setup === "ready",
				)
				.map((row) => row.providerId),
		) ??
		catalog.image?.providerId ??
		"e2b";
	const sandboxStatus = cloudSandboxStatus(
		catalog,
		sandboxProvider,
		project?.projectId ?? null,
	);
	// Only block on known readiness; without provider data the server decides.
	const sandboxBlocked =
		catalog.providers.length > 0 && sandboxStatus.setup !== "ready";
	const provider =
		agent !== null && providers.some((id) => id === agent)
			? agent
			: providers[0];
	const selectedModel =
		provider === undefined
			? ""
			: agent === provider &&
					model !== null &&
					modelOptionsForProvider(modelCatalog, provider).some(
						(row) => row.value === model,
					)
				? model
				: defaultModelFor(modelCatalog, provider);
	useEffect(() => {
		void refreshCloudCatalog();
	}, []);
	useEffect(() => {
		let active = true;
		void hydrateComposerDraft(draftKey).then((draft) => {
			if (!active) return;
			if (params.draft === undefined && draft !== null) setText(draft.text);
			setHydrated(true);
		});
		return () => {
			active = false;
		};
	}, [draftKey, params.draft]);
	useEffect(() => {
		if (hydrated && !busy && !completed.current)
			setComposerDraft(draftKey, { ...composerDraft(draftKey), text });
	}, [draftKey, hydrated, busy, text]);
	// Rebuild just the selected provider's image; readiness refreshes after.
	const rebuildSandboxImage = async () => {
		setBusy(true);
		setError(null);
		try {
			await Effect.runPromise(
				cloudControlClient["cloud.image.build"]({
					mode: "update",
					providerId: sandboxProvider,
					idempotencyKey: crypto.randomUUID(),
				}),
			);
			await refreshCloudCatalog();
		} catch (cause) {
			setError(connectionErrorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const submit = async () => {
		if (
			submitting.current ||
			account === null ||
			project === undefined ||
			provider === undefined ||
			sandboxBlocked ||
			!text.trim()
		)
			return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		try {
			const result = await launchMobileCloudChat({
				accountId: account.id,
				draftKey,
				project,
				providerId: sandboxProvider,
				agent: provider,
				model: selectedModel,
				runtimeMode,
				text,
			});
			completed.current = true;
			router.replace({
				pathname: "/c/[conn]/session/[sessionId]",
				params: { conn: result.connectionKey, sessionId: result.sessionId },
			});
		} catch (cause) {
			setError(connectionErrorMessage(cause));
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};
	return (
		<ScrollView
			className="flex-1 bg-background"
			contentContainerClassName="gap-4 px-5 pb-12 pt-4"
			contentInsetAdjustmentBehavior="automatic"
			keyboardShouldPersistTaps="handled"
		>
			<Stack.Screen
				options={{ title: "New Cloud Chat", headerLargeTitle: false }}
			/>
			<Text className="font-sans text-sm text-muted-foreground">
				Runs in your account’s cloud workspace. No connected computer needed.
			</Text>
			{account === null ? (
				<Button onPress={() => void signIn()}>Sign In</Button>
			) : (
				<>
					<SelectorRow
						compact
						symbol="folder"
						label={project?.displayName ?? "No cloud repositories"}
						disabled={busy}
						options={catalog.projects.map((row) => ({
							key: row.projectId,
							label: row.displayName,
							selected: row === project,
							onSelect: () => setProjectId(row.projectId),
						}))}
					/>
					{sandboxProviders.length > 1 ? (
						<SelectorRow
							compact
							symbol="cloud"
							label={`Cloud · ${cloudProviderLabel(sandboxProvider)}`}
							disabled={busy}
							options={sandboxProviders.map((row) => ({
								key: row.providerId,
								label: [
									cloudProviderLabel(row.providerId),
									cloudSandboxStatus(
										catalog,
										row.providerId,
										project?.projectId ?? null,
									).label,
								]
									.filter((part) => part !== null)
									.join(" — "),
								selected: row.providerId === sandboxProvider,
								onSelect: () => setSandbox(row.providerId),
							}))}
						/>
					) : null}
					<SelectorRow
						compact
						symbol="cpu"
						label={
							provider === undefined
								? "Connect a provider"
								: providerLabel(provider)
						}
						disabled={busy}
						options={providers.map((id) => ({
							key: id,
							label: providerLabel(id),
							selected: id === provider,
							onSelect: () => {
								setAgent(id);
								setModel(null);
							},
						}))}
					/>
					{provider !== undefined ? (
						<SelectorRow
							compact
							symbol="sparkles"
							label={selectedModel}
							disabled={busy}
							options={modelOptionsForProvider(modelCatalog, provider).map(
								(row) => ({
									key: row.value,
									label: row.label,
									selected: row.value === selectedModel,
									onSelect: () => {
										setAgent(provider);
										setModel(row.value);
									},
								}),
							)}
						/>
					) : null}
					<SelectorRow
						compact
						symbol="lock"
						label={
							RUNTIME_OPTIONS.find((row) => row.value === runtimeMode)?.label ??
							runtimeMode
						}
						disabled={busy}
						options={RUNTIME_OPTIONS.map((row) => ({
							key: row.value,
							label: row.label,
							selected: row.value === runtimeMode,
							onSelect: () => setRuntimeMode(row.value),
						}))}
					/>
					<Button
						size="sm"
						variant="ghost"
						onPress={() => router.push("/cloud-auth")}
					>
						Manage Providers
					</Button>
					{project === undefined ? (
						<Text className="font-sans text-sm text-muted-foreground">
							Connect a repository in Cloud Workspace settings first.
						</Text>
					) : sandboxBlocked && sandboxStatus.label !== null ? (
						<View className="flex-row items-center gap-2">
							<Text className="flex-1 font-sans text-sm text-muted-foreground">
								{`${cloudProviderLabel(sandboxProvider)}: ${sandboxStatus.label}`}
							</Text>
							{sandboxStatus.setup === "update-image" ||
							sandboxStatus.setup === "rebuild-authentication" ? (
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onPress={() => void rebuildSandboxImage()}
								>
									Update Image
								</Button>
							) : null}
						</View>
					) : null}
					<TextInput
						accessibilityLabel="First message"
						multiline
						editable={!busy}
						value={text}
						onChangeText={setText}
						placeholder="What should the agent work on?"
						className="min-h-28 rounded-xl bg-muted p-3 font-sans text-base text-foreground"
					/>
					{busy ? (
						<View accessibilityLiveRegion="polite" className="flex-row gap-2">
							<ActivityIndicator />
							<Text className="font-sans text-sm text-muted-foreground">
								Starting…
							</Text>
						</View>
					) : null}
					{(error ?? catalog.error) ? (
						<Text
							accessibilityRole="alert"
							className="font-sans text-sm text-danger"
						>
							{error ?? catalog.error}
						</Text>
					) : null}
					<Button
						disabled={
							busy ||
							!hydrated ||
							!text.trim() ||
							provider === undefined ||
							project === undefined ||
							sandboxBlocked
						}
						onPress={() => void submit()}
					>
						Start Chat
					</Button>
				</>
			)}
		</ScrollView>
	);
}
