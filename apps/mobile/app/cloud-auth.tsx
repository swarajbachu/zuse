import { useAtomValue } from "@effect/atom-react";
import { workspaceScopeKey } from "@zuse/client-runtime/environment-scope";
import type {
	CloudAuthLoginOperation,
	CloudAuthMethod,
	CloudAuthProvider,
} from "@zuse/contracts";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	AppState,
	Linking,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { Button } from "~/components/ui/button";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { PROVIDER_LABEL } from "~/lib/model-options";
import { authAccountAtom, signIn } from "~/store/auth";
import { createCloudAuthController } from "~/store/cloud-auth";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
	refreshCloudCatalog,
} from "~/store/cloud-catalog";

export default function CloudAuthenticationScreen() {
	const account = useAtomValue(authAccountAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const scope = catalog.scope;
	const organization =
		scope.kind === "organization"
			? catalog.organizations.find((entry) => entry.id === scope.organizationId)
			: undefined;
	if (account === null || catalog.accountId !== account.id)
		return (
			<View className="flex-1 gap-4 bg-background p-5">
				<Text className="text-muted-foreground">
					Sign in to configure Cloud Authentication.
				</Text>
				<Button className="h-7" onPress={() => void signIn()}>
					Sign in
				</Button>
			</View>
		);
	if (scope.kind === "organization" && organization?.role !== "admin")
		return (
			<View className="flex-1 gap-4 bg-background p-5">
				<Stack.Screen options={{ title: "Cloud Authentication" }} />
				<Text className="text-muted-foreground">
					Only organization administrators can configure provider credentials
					and cloud images.
				</Text>
			</View>
		);
	return (
		<CloudAuthenticationForm
			key={`${account.id}:${workspaceScopeKey(scope)}:${cloudCatalogGeneration()}`}
			workspaceName={
				scope.kind === "personal"
					? "Personal"
					: (organization?.name ?? "Organization")
			}
		/>
	);
}

function CloudAuthenticationForm({ workspaceName }: { workspaceName: string }) {
	const catalog = useAtomValue(cloudCatalogAtom);
	const [controller] = useState(createCloudAuthController);
	const [provider, setProvider] = useState<CloudAuthProvider | null>(null);
	const [method, setMethod] = useState<CloudAuthMethod>("subscription");
	const [secret, setSecret] = useState("");
	const [operation, setOperation] = useState<CloudAuthLoginOperation | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void refreshCloudCatalog();
	}, []);
	useEffect(() => {
		if (operation?.state !== "authorizing") return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			if (disposed || !controller.isCurrent()) return;
			if (AppState.currentState === "background") {
				timer = setTimeout(poll, 2_000);
				return;
			}
			try {
				const result = await controller.poll(operation.operationId);
				if (disposed) return;
				setOperation(result);
				if (result.state === "connected") {
					await refreshCloudCatalog();
					return;
				}
				if (result.state !== "authorizing") return;
			} catch (cause) {
				if (!disposed && controller.isCurrent())
					setError(connectionErrorMessage(cause));
			}
			if (!disposed) timer = setTimeout(poll, 2_000);
		};
		timer = setTimeout(poll, 1_000);
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	}, [controller, operation?.operationId, operation?.state]);
	const configure = async () => {
		if (provider === null || busy) return;
		setBusy(true);
		setError(null);
		try {
			const login = await controller.configure(provider, method, secret);
			setOperation(login);
			if (login === null) {
				setSecret("");
				setProvider(null);
				await refreshCloudCatalog();
			}
		} catch (cause) {
			if (controller.isCurrent()) setError(connectionErrorMessage(cause));
		} finally {
			if (controller.isCurrent()) setBusy(false);
		}
	};
	const deviceLogin =
		method === "subscription" && (provider === "codex" || provider === "grok");
	return (
		<ScrollView
			className="flex-1 bg-background"
			contentContainerClassName="gap-4 px-5 pb-12 pt-4"
			contentInsetAdjustmentBehavior="automatic"
			keyboardShouldPersistTaps="handled"
		>
			<Stack.Screen
				options={{ title: "Cloud Authentication", headerLargeTitle: false }}
			/>
			<Text className="font-sans text-sm text-muted-foreground">
				{workspaceName} · Credentials are shared only with new cloud chats in
				this workspace. Organization credentials never inherit your Personal
				logins.
			</Text>
			<View className="gap-2">
				<Text className="font-sans-medium text-sm text-foreground">
					Workspace image · {catalog.image?.state ?? "Loading"}
				</Text>
				<Text
					role="status"
					aria-live="polite"
					className="font-sans text-xs text-muted-foreground"
				>
					{catalog.image?.progressPhase ??
						"Update the image after connecting a provider. Existing retained chats keep their original authentication mode."}
				</Text>
				<Button
					className="h-7"
					variant="ghost"
					disabled={busy || catalog.image?.state === "building"}
					onPress={() => {
						setBusy(true);
						setError(null);
						void controller
							.updateImage()
							.then(() => refreshCloudCatalog())
							.catch((cause) => {
								if (controller.isCurrent())
									setError(connectionErrorMessage(cause));
							})
							.finally(() => {
								if (controller.isCurrent()) setBusy(false);
							});
					}}
				>
					Update workspace image
				</Button>
			</View>
			{(["codex", "claude", "grok", "cursor"] as const).map((id) => (
				<View key={id} className="flex-row items-center gap-3">
					<View className="flex-1">
						<Text className="font-sans-medium text-sm text-foreground">
							{PROVIDER_LABEL[id]}
						</Text>
						<Text className="font-sans text-xs text-muted-foreground">
							{catalog.auth?.providers.find((row) => row.providerId === id)
								?.state ?? "Not connected"}
						</Text>
					</View>
					<Button
						className="h-7"
						variant="ghost"
						disabled={busy || operation?.state === "authorizing"}
						onPress={() => {
							setProvider(id);
							setSecret("");
							setMethod("subscription");
							setOperation(null);
						}}
					>
						Connect
					</Button>
				</View>
			))}
			{provider === null ? null : (
				<View className="gap-3 rounded-xl bg-muted/50 p-3">
					<Text className="font-sans-medium text-sm text-foreground">
						{PROVIDER_LABEL[provider]}
					</Text>
					<View className="flex-row gap-2">
						<Button
							className="h-7"
							variant="ghost"
							disabled={busy || operation?.state === "authorizing"}
							onPress={() => setMethod("subscription")}
						>
							Subscription
						</Button>
						<Button
							className="h-7"
							variant="ghost"
							disabled={busy || operation?.state === "authorizing"}
							onPress={() => setMethod("api-key")}
						>
							API key
						</Button>
					</View>
					{!deviceLogin ? (
						<>
							<Text className="font-sans text-xs text-muted-foreground">
								{method === "api-key"
									? "Provider API key"
									: provider === "claude"
										? "Paste your Claude setup token from claude setup-token."
										: "Paste your Cursor subscription access token."}{" "}
								This is encrypted before leaving your phone.
							</Text>
							<TextInput
								accessibilityLabel="Provider credential"
								secureTextEntry
								autoCapitalize="none"
								autoCorrect={false}
								value={secret}
								onChangeText={setSecret}
								className="h-7 rounded-md bg-muted px-2 font-sans text-sm text-foreground"
							/>
						</>
					) : null}
					{operation?.state === "authorizing" ? (
						<View accessibilityLiveRegion="polite" className="gap-2">
							<Text selectable className="font-mono text-base text-foreground">
								{operation.verificationCode}
							</Text>
							<Text className="font-sans text-xs text-muted-foreground">
								Complete the account login in your browser, then return here.
							</Text>
							{operation.verificationUrl ? (
								<Button
									className="h-7"
									onPress={() =>
										operation.verificationUrl === undefined
											? undefined
											: void Linking.openURL(operation.verificationUrl)
									}
								>
									Open sign-in page
								</Button>
							) : null}
							<Button
								className="h-7"
								variant="ghost"
								onPress={() =>
									void controller
										.cancel(operation.operationId)
										.then(setOperation)
										.catch((cause) => {
											if (controller.isCurrent())
												setError(connectionErrorMessage(cause));
										})
								}
							>
								Cancel login
							</Button>
						</View>
					) : (
						<Button
							className="h-7"
							disabled={busy || (!deviceLogin && secret.trim().length < 8)}
							onPress={() => void configure()}
						>
							{deviceLogin ? "Start account login" : "Save credential"}
						</Button>
					)}
				</View>
			)}
			{busy ? (
				<View accessibilityLiveRegion="polite" className="flex-row gap-2">
					<ActivityIndicator />
					<Text className="font-sans text-sm text-muted-foreground">
						Updating Cloud Authentication…
					</Text>
				</View>
			) : null}
			{operation?.state === "connected" ? (
				<Text className="font-sans text-sm text-foreground">
					Account connected. New cloud chats can use it.
				</Text>
			) : null}
			{error || operation?.state === "error" ? (
				<Text
					accessibilityRole="alert"
					className="font-sans text-sm text-destructive"
				>
					{error ?? operation?.errorCode ?? "Account login could not complete."}
				</Text>
			) : null}
		</ScrollView>
	);
}
