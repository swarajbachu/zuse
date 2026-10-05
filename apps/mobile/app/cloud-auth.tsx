import { useAtomValue } from "@effect/atom-react";
import type {
	CloudAuthLoginOperation,
	CloudAuthMethod,
	CloudAuthProvider,
} from "@zuse/contracts";
import { sealCloudAuthSecret } from "@zuse/utils/cloud-auth-crypto";
import { Effect } from "effect";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
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
import { cloudControlClient } from "~/rpc/api-client";
import { authAccountAtom, signIn } from "~/store/auth";
import { cloudCatalogAtom, refreshCloudCatalog } from "~/store/cloud-catalog";

export default function CloudAuthenticationScreen() {
	const account = useAtomValue(authAccountAtom);
	const accountId = account?.id;
	const currentAccount = useRef(accountId);
	currentAccount.current = accountId;
	const catalog = useAtomValue(cloudCatalogAtom);
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
		if (currentAccount.current !== accountId) return;
		setSecret("");
		setOperation(null);
		setProvider(null);
	}, [accountId]);
	useEffect(() => {
		if (operation?.state !== "authorizing") return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			if (disposed) return;
			if (AppState.currentState === "background") {
				timer = setTimeout(poll, 2_000);
				return;
			}
			try {
				const result = await Effect.runPromise(
					cloudControlClient["cloud.auth.login.poll"]({
						operationId: operation.operationId,
					}),
				);
				if (disposed) return;
				setOperation(result);
				if (result.state === "connected") {
					await refreshCloudCatalog();
					return;
				}
				if (result.state !== "authorizing") return;
			} catch (cause) {
				if (!disposed) setError(connectionErrorMessage(cause));
			}
			if (!disposed) timer = setTimeout(poll, 2_000);
		};
		timer = setTimeout(poll, 1_000);
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	}, [operation?.operationId, operation?.state]);
	const configure = async () => {
		if (provider === null || busy) return;
		const assertAccount = () => {
			if (currentAccount.current !== accountId)
				throw new Error("Account changed. Reopen Cloud Providers.");
		};
		setBusy(true);
		setError(null);
		try {
			if (
				method === "subscription" &&
				(provider === "codex" || provider === "grok")
			) {
				const login = await Effect.runPromise(
					cloudControlClient["cloud.auth.login.start"]({
						providerId: provider,
					}),
				);
				assertAccount();
				setOperation(login);
			} else {
				const status =
					catalog.auth?.encryptionPublicJwk === undefined
						? await Effect.runPromise(
								cloudControlClient["cloud.auth.provision"](),
							)
						: catalog.auth;
				if (
					status.encryptionPublicJwk === undefined ||
					status.encryptionKeyId === undefined
				)
					throw new Error(
						"Cloud Providers is still preparing. Try again shortly.",
					);
				const ciphertext = await sealCloudAuthSecret(
					status.encryptionPublicJwk,
					secret.trim(),
				);
				assertAccount();
				await Effect.runPromise(
					cloudControlClient["cloud.auth.configure"]({
						providerId: provider,
						method,
						sealedSecret: { keyId: status.encryptionKeyId, ciphertext },
					}),
				);
				assertAccount();
				setSecret("");
				setProvider(null);
				await refreshCloudCatalog();
			}
		} catch (cause) {
			if (currentAccount.current === accountId)
				setError(connectionErrorMessage(cause));
		} finally {
			setBusy(false);
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
				options={{ title: "Cloud Providers", headerLargeTitle: false }}
			/>
			<Text className="font-sans text-sm text-muted-foreground">
				Connect providers once for all your new cloud chats.
			</Text>
			{account === null ? (
				<Button onPress={() => void signIn()}>Sign In</Button>
			) : (
				<>
					<View className="gap-2">
						<Text className="font-sans-medium text-sm text-foreground">
							Account image · {catalog.image?.state ?? "Loading"}
						</Text>
						<Text
							role="status"
							aria-live="polite"
							className="font-sans text-xs text-muted-foreground"
						>
							{catalog.image?.progressPhase ??
								"Update after connecting a provider. Existing chats keep their setup."}
						</Text>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy || catalog.image?.state === "building"}
							onPress={() => {
								setBusy(true);
								setError(null);
								void Effect.runPromise(
									cloudControlClient["cloud.image.build"]({
										mode: "update",
										idempotencyKey: crypto.randomUUID(),
									}),
								)
									.then(() => refreshCloudCatalog())
									.catch((cause) => setError(connectionErrorMessage(cause)))
									.finally(() => setBusy(false));
							}}
						>
							Update Image
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
								size="sm"
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
									size="sm"
									variant={method === "subscription" ? "secondary" : "ghost"}
									disabled={busy || operation?.state === "authorizing"}
									onPress={() => setMethod("subscription")}
								>
									Subscription
								</Button>
								<Button
									size="sm"
									variant={method === "api-key" ? "secondary" : "ghost"}
									disabled={busy || operation?.state === "authorizing"}
									onPress={() => setMethod("api-key")}
								>
									API Key
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
										className="h-9 rounded-lg bg-muted px-3 font-sans text-[15px] text-foreground"
									/>
								</>
							) : null}
							{operation?.state === "authorizing" ? (
								<View accessibilityLiveRegion="polite" className="gap-2">
									<Text
										selectable
										className="font-mono text-base text-foreground"
									>
										{operation.verificationCode}
									</Text>
									<Text className="font-sans text-xs text-muted-foreground">
										Finish signing in in your browser, then come back.
									</Text>
									{operation.verificationUrl ? (
										<Button
											size="sm"
											onPress={() =>
												operation.verificationUrl === undefined
													? undefined
													: void Linking.openURL(operation.verificationUrl)
											}
										>
											Open Browser
										</Button>
									) : null}
									<Button
										size="sm"
										variant="ghost"
										onPress={() =>
											void Effect.runPromise(
												cloudControlClient["cloud.auth.login.cancel"]({
													operationId: operation.operationId,
												}),
											)
												.then(setOperation)
												.catch((cause) =>
													setError(connectionErrorMessage(cause)),
												)
										}
									>
										Cancel
									</Button>
								</View>
							) : (
								<Button
									size="sm"
									disabled={busy || (!deviceLogin && secret.trim().length < 8)}
									onPress={() => void configure()}
								>
									{deviceLogin ? "Sign In" : "Save"}
								</Button>
							)}
						</View>
					)}
					{busy ? (
						<View accessibilityLiveRegion="polite" className="flex-row gap-2">
							<ActivityIndicator />
							<Text className="font-sans text-sm text-muted-foreground">
								Updating…
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
							className="font-sans text-sm text-danger"
						>
							{error ??
								operation?.errorCode ??
								"Account login could not complete."}
						</Text>
					) : null}
				</>
			)}
		</ScrollView>
	);
}
