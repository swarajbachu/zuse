import { DEFAULT_LOCAL_DESKTOP_PORT } from "@zuse/contracts";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
	KeyboardAvoidingView,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "~/components/ui/button";
import { returnToInbox } from "~/lib/connection-navigation";
import { addConnection } from "~/store/connections";
import { colors } from "~/theme";

/** Manual connection setup in the same root navigation stack as the inbox. */
export default function ManualConnectScreen() {
	const insets = useSafeAreaInsets();
	const [host, setHost] = useState("127.0.0.1");
	const [port, setPort] = useState(String(DEFAULT_LOCAL_DESKTOP_PORT));
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const canAdd = useMemo(
		() => host.trim().length > 0 && Number(port) > 0,
		[host, port],
	);

	const submit = async () => {
		if (!canAdd || busy) return;
		setBusy(true);
		setError(null);
		try {
			await addConnection({ host, port: Number(port), token, source: "manual" });
			returnToInbox(router);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not reach that connection. Check the address and try again.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
			<ScrollView
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="gap-6 p-4"
				keyboardShouldPersistTaps="handled"
			>
				<View
					style={{ borderCurve: "continuous" }}
					className="overflow-hidden rounded-2xl border border-border bg-card"
				>
					<Field
						label="Host"
						value={host}
						onChangeText={setHost}
						autoCapitalize="none"
						autoCorrect={false}
						placeholder="127.0.0.1"
					/>
					<View className="ml-4 h-px bg-border" />
					<Field
						label="Port"
						value={port}
						onChangeText={setPort}
						keyboardType="number-pad"
						placeholder={String(DEFAULT_LOCAL_DESKTOP_PORT)}
					/>
					<View className="ml-4 h-px bg-border" />
					<Field
						label="Token"
						value={token}
						onChangeText={setToken}
						autoCapitalize="none"
						autoCorrect={false}
						placeholder="Optional"
					/>
				</View>

				{error === null ? null : (
					<Text selectable className="font-sans text-sm text-danger">
						{error}
					</Text>
				)}

				<Button disabled={!canAdd || busy} onPress={submit}>
					{busy
						? "Connecting…"
						: error === null
							? "Save connection"
							: "Try again"}
				</Button>
			</ScrollView>
			<View style={{ height: insets.bottom }} />
		</KeyboardAvoidingView>
	);
}

function Field({
	label,
	...props
}: { label: string } & React.ComponentProps<typeof TextInput>) {
	return (
		<View className="min-h-[54px] flex-row items-center gap-3 px-4 py-2.5">
			<Text className="w-20 font-sans text-[17px] text-foreground">
				{label}
			</Text>
			<TextInput
				className="flex-1 font-sans text-[17px] text-foreground"
				placeholderTextColor={colors.secondaryFg}
				{...props}
			/>
		</View>
	);
}
