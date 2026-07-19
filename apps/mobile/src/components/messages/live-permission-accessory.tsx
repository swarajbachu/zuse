import type { PermissionDecision, PermissionRequest } from "@zuse/contracts";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { GlassSurface } from "~/components/ui/glass-surface";
import { cn } from "~/lib/cn";
import {
	describePermissionKind,
	permissionQuestion,
} from "~/lib/permission-presentation";
import { colors } from "~/theme";

export function LivePermissionAccessory({
	requests,
	bottomInset,
	onDecide,
	onDenyWithMessage,
}: {
	requests: readonly PermissionRequest[];
	bottomInset: number;
	onDecide: (
		request: PermissionRequest,
		decision: PermissionDecision,
	) => void | Promise<void>;
	/**
	 * Deny the request and hand the agent free-text guidance to try next. Empty
	 * text falls back to a plain Deny.
	 */
	onDenyWithMessage: (
		request: PermissionRequest,
		message: string,
	) => void | Promise<void>;
}) {
	const [decidingId, setDecidingId] = useState<string | null>(null);
	const [denyText, setDenyText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [denying, setDenying] = useState(false);
	const request = requests[0];

	if (!request) return null;

	const { detail, mono } = describePermissionKind(request.kind);
	const question = permissionQuestion(request.kind);
	const countLabel = requests.length > 1 ? ` +${requests.length - 1}` : "";
	const busy = decidingId !== null;

	const run = async (task: () => void | Promise<void>) => {
		if (busy) return;
		setDecidingId(request.id);
		setError(null);
		try {
			await task();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setDecidingId(null);
			setDenyText("");
		}
	};

	const decide = (decision: PermissionDecision) =>
		void run(() => onDecide(request, decision));

	const deny = () => {
		const message = denyText.trim();
		void run(() =>
			message.length > 0
				? onDenyWithMessage(request, message)
				: onDecide(request, { _tag: "Deny" }),
		);
	};

	return (
		<View
			pointerEvents="box-none"
			style={{ paddingBottom: Math.max(bottomInset, 8) }}
			className="px-3 pt-2"
		>
			<GlassSurface style={{ padding: 16, gap: 12 }}>
				<Text className="font-sans-medium text-[12px] uppercase tracking-wide text-primary">
					Permission{countLabel}
				</Text>
				<Text className="font-sans-bold text-[16px] leading-5 text-foreground">
					{question}
				</Text>
				{mono ? (
					<View
						className="rounded-xl border border-border bg-card px-3 py-2"
						style={{ borderCurve: "continuous" }}
					>
						<Text
							selectable
							className="font-mono text-[12px] leading-5 text-foreground"
							numberOfLines={4}
						>
							{detail}
						</Text>
					</View>
				) : (
					<Text
						className="font-sans text-[13px] leading-5 text-muted-foreground"
						numberOfLines={3}
					>
						{detail}
					</Text>
				)}
				{error === null ? null : <ErrorText message={error} />}
				<PrimaryButton
					label="Allow once"
					busy={busy}
					onPress={() => decide({ _tag: "AllowOnce" })}
				/>
				{request.forcePrompt ? null : (
					<View className="flex-row gap-2">
						<View className="flex-1">
							<SecondaryButton
								label="For session"
								busy={busy}
								onPress={() => decide({ _tag: "AllowForSession" })}
							/>
						</View>
						<View className="flex-1">
							<SecondaryButton
								label="Always for folder"
								busy={busy}
								onPress={() => decide({ _tag: "AlwaysAllow", scope: "folder" })}
							/>
						</View>
					</View>
				)}
				{denying ? (
					<TextInput
						className="min-h-11 rounded-xl bg-card px-4 py-2.5 font-sans text-[15px] text-foreground"
						placeholder="Add a note to deny with (optional)"
						placeholderTextColor={colors.tertiaryFg}
						value={denyText}
						onChangeText={setDenyText}
						editable={!busy}
						multiline
						style={{ borderCurve: "continuous" }}
					/>
				) : null}
				<SecondaryButton
					label={denying && denyText.trim().length > 0 ? "Send & deny" : "Deny"}
					busy={busy}
					danger
					onPress={denying ? deny : () => setDenying(true)}
				/>
			</GlassSurface>
		</View>
	);
}

const ErrorText = ({ message }: { message: string }) => (
	<Text selectable className="font-sans text-[13px] leading-5 text-danger">
		{message}
	</Text>
);

const PrimaryButton = ({
	label,
	busy,
	onPress,
}: {
	label: string;
	busy: boolean;
	onPress: () => void;
}) => (
	<Pressable
		accessibilityRole="button"
		disabled={busy}
		onPress={onPress}
		className="h-12 items-center justify-center rounded-xl bg-foreground active:opacity-80"
		style={{ borderCurve: "continuous", opacity: busy ? 0.45 : 1 }}
	>
		<Text className="font-sans-medium text-[16px] text-background">
			{label}
		</Text>
	</Pressable>
);

const SecondaryButton = ({
	label,
	busy,
	danger,
	onPress,
}: {
	label: string;
	busy: boolean;
	danger?: boolean;
	onPress: () => void;
}) => (
	<Pressable
		accessibilityRole="button"
		disabled={busy}
		onPress={onPress}
		className="h-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
		style={{ borderCurve: "continuous", opacity: busy ? 0.45 : 1 }}
	>
		<Text
			className={cn(
				"font-sans-medium text-[15px]",
				danger ? "text-danger" : "text-foreground",
			)}
		>
			{label}
		</Text>
	</Pressable>
);
