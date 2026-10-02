import { useAtomValue } from "@effect/atom-react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	authAccountAtom,
	authBusyAtom,
	authErrorAtom,
	authHydratedAtom,
	hydrateAuth,
	signIn,
} from "~/store/auth";
import { cloudCatalogAtom } from "~/store/cloud-catalog";
import { resolveMobileCloudChatLink } from "~/store/cloud-chat-link";

export default function SharedChatScreen() {
	const [attempt, setAttempt] = useState(0);
	return (
		<SharedChatContent
			key={attempt}
			onRetry={() => setAttempt((value) => value + 1)}
		/>
	);
}

function SharedChatContent({ onRetry }: { onRetry: () => void }) {
	const { path } = useLocalSearchParams<{ path?: string | string[] }>();
	const account = useAtomValue(authAccountAtom);
	const accountId = account?.id ?? null;
	const hydrated = useAtomValue(authHydratedAtom);
	const busy = useAtomValue(authBusyAtom);
	const authError = useAtomValue(authErrorAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	const [error, setError] = useState<string | null>(null);
	const pathname = typeof path === "string" ? path : "";
	useEffect(() => {
		if (!hydrated) void hydrateAuth();
	}, [hydrated]);
	useEffect(() => {
		if (!hydrated || accountId === null || catalog.accountId !== accountId)
			return;
		const controller = new AbortController();
		setError(null);
		void resolveMobileCloudChatLink(pathname, controller.signal)
			.then((href) => {
				if (!controller.signal.aborted) router.replace(href);
			})
			.catch((cause) => {
				if (!controller.signal.aborted) setError(connectionErrorMessage(cause));
			});
		return () => controller.abort();
	}, [hydrated, accountId, catalog.accountId, pathname]);
	return (
		<View className="flex-1 gap-4 bg-background px-5 pt-6">
			<Stack.Screen
				options={{ title: "Shared chat", headerLargeTitle: false }}
			/>
			{!hydrated || (account !== null && error === null) ? (
				<ActivityIndicator />
			) : account === null ? (
				<>
					<Text className="text-muted-foreground">
						Sign in to open this chat. The link does not grant access to the
						workspace.
					</Text>
					<Button
						className="h-7"
						disabled={busy}
						onPress={() => {
							void signIn();
						}}
					>
						Sign in
					</Button>
					{authError ? (
						<Text accessibilityRole="alert" className="text-danger">
							{authError}
						</Text>
					) : null}
				</>
			) : (
				<>
					<Text accessibilityRole="alert" className="text-danger">
						{error}
					</Text>
					<Button className="h-7" onPress={onRetry}>
						Try again
					</Button>
				</>
			)}
			<Button
				className="h-7"
				variant="ghost"
				onPress={() => router.replace("/")}
			>
				Back to chats
			</Button>
		</View>
	);
}
