import { useAtomValue } from "@effect/atom-react";
import {
	DEFAULT_RUNTIME_MODE,
	defaultModelFor,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
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
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	modelOptionsForProvider,
	PROVIDER_LABEL,
	RUNTIME_OPTIONS,
} from "~/lib/model-options";
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

export default function NewCloudChatScreen() {
	const account = useAtomValue(authAccountAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const providers = useAtomValue(cloudAuthenticatedProvidersAtom);
	const params = useLocalSearchParams<{ draft?: string; projectId?: string }>();
	const draftKey = `new-cloud:${account?.id ?? "signed-out"}`;
	const [text, setText] = useState(
		params.draft ?? composerDraft(draftKey).text,
	);
	const [projectId, setProjectId] = useState(params.projectId);
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
	const provider =
		agent !== null && providers.some((id) => id === agent)
			? agent
			: providers[0];
	const selectedModel =
		provider === undefined
			? ""
			: agent === provider &&
					model !== null &&
					modelOptionsForProvider(provider).some((row) => row.value === model)
				? model
				: defaultModelFor(provider);
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
	const submit = async () => {
		if (
			submitting.current ||
			account === null ||
			project === undefined ||
			provider === undefined ||
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
				providerId: catalog.image?.providerId ?? "e2b",
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
				options={{ title: "New cloud chat", headerLargeTitle: false }}
			/>
			<Text className="font-sans text-sm text-muted-foreground">
				Runs in your account’s cloud workspace. No connected computer needed.
			</Text>
			{account === null ? (
				<Button className="h-7" onPress={() => void signIn()}>
					Sign in
				</Button>
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
					<SelectorRow
						compact
						symbol="cpu"
						label={
							provider === undefined
								? "Connect a provider"
								: PROVIDER_LABEL[provider]
						}
						disabled={busy}
						options={providers.map((id) => ({
							key: id,
							label: PROVIDER_LABEL[id],
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
							options={modelOptionsForProvider(provider).map((row) => ({
								key: row.value,
								label: row.label,
								selected: row.value === selectedModel,
								onSelect: () => {
									setAgent(provider);
									setModel(row.value);
								},
							}))}
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
						className="h-7"
						variant="ghost"
						onPress={() => router.push("/cloud-auth")}
					>
						Cloud Authentication
					</Button>
					{project === undefined ? (
						<Text className="font-sans text-sm text-muted-foreground">
							Connect a repository in Cloud Workspace settings before creating a
							chat.
						</Text>
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
								Saving your message to the cloud…
							</Text>
						</View>
					) : null}
					{(error ?? catalog.error) ? (
						<Text
							accessibilityRole="alert"
							className="font-sans text-sm text-destructive"
						>
							{error ?? catalog.error}
						</Text>
					) : null}
					<Button
						className="h-7"
						disabled={
							busy ||
							!hydrated ||
							!text.trim() ||
							provider === undefined ||
							project === undefined
						}
						onPress={() => void submit()}
					>
						Start cloud chat
					</Button>
				</>
			)}
		</ScrollView>
	);
}
