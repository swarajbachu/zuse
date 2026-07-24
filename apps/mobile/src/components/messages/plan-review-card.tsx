import type { PendingPlanInteraction } from "@zuse/client-runtime/plan-interactions";
import { Pencil } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/store/registry";

import { GlassSurface } from "~/components/ui/glass-surface";
import { colors } from "~/theme";

type PlanAction = "approve" | "feedback" | "handoff" | "abandon";

export function PlanReviewCard({
	interaction,
	bottomInset,
	onAction,
}: {
	interaction: PendingPlanInteraction;
	bottomInset: number;
	onAction: (action: PlanAction, feedback: string) => Promise<void>;
}) {
	const draftKey =
		interaction.sourceMessageId ??
		(interaction.kind === "permission"
			? interaction.request.id
			: "pending-plan");
	const feedback = useAtomValue(planReviewDraftAtom(draftKey));
	const [busy, setBusy] = useState<PlanAction | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const hasPlan =
		interaction.plan !== null && interaction.plan.trim().length > 0;
	const hasFeedback = feedback.trim().length > 0;

	useEffect(() => {
		void interaction.sourceMessageId;
		setError(null);
		setSuccess(null);
	}, [interaction.sourceMessageId]);

	const run = async (action: PlanAction) => {
		if (busy !== null) return;
		if ((action === "approve" || action === "handoff") && !hasPlan) {
			setError(
				"The exact plan body is unavailable. Reconnect and retry before building it.",
			);
			return;
		}
		if (action === "feedback" && feedback.trim().length === 0) {
			setError("Add the feedback you want the planner to apply.");
			return;
		}
		setBusy(action);
		setError(null);
		setSuccess(null);
		try {
			await onAction(action, feedback.trim());
			if (action === "feedback") setFeedback(draftKey, "");
			setSuccess(
				action === "feedback"
					? "Feedback sent"
					: action === "handoff"
						? "Build session created"
						: action === "abandon"
							? "Plan abandoned"
							: "Plan approved",
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	const confirmHandoff = () => {
		if (busy !== null || !hasPlan) return;
		Alert.alert(
			"Hand off this plan?",
			"This creates a new build chat using this exact plan. Your planning chat and its history will stay here.",
			[
				{ text: "Not now", style: "cancel" },
				{ text: "Hand off", onPress: () => void run("handoff") },
			],
		);
	};

	return (
		<View
			className="px-3 pt-2"
			style={{ paddingBottom: Math.max(bottomInset, 8) }}
		>
			<GlassSurface style={{ padding: 16, gap: 14 }}>
				{error ? (
					<Text
						selectable
						className="font-sans text-[13px] leading-5 text-danger"
					>
						{error}
					</Text>
				) : null}
				{success ? (
					<Text className="font-sans text-[13px] text-primary">{success}</Text>
				) : null}
				<View className="flex-row gap-2">
					<View className="flex-1">
						<ActionButton
							label="Approve"
							primary
							disabled={!hasPlan || busy !== null}
							busy={busy === "approve"}
							onPress={() => void run("approve")}
						/>
					</View>
					<View className="flex-1">
						<ActionButton
							label="Hand off"
							disabled={!hasPlan || busy !== null}
							busy={busy === "handoff"}
							onPress={confirmHandoff}
						/>
					</View>
				</View>
				<View
					className="flex-row items-end gap-2 pt-3"
					style={{
						borderTopColor: colors.border,
						borderTopWidth: StyleSheet.hairlineWidth,
					}}
				>
					<View className="h-11 w-8 items-center justify-center">
						<Pencil size={17} color={colors.tertiaryFg} />
					</View>
					<TextInput
						accessibilityLabel="Plan feedback"
						className="max-h-24 min-h-11 flex-1 py-2.5 font-sans text-base text-foreground"
						placeholder="Describe changes"
						placeholderTextColor={colors.tertiaryFg}
						value={feedback}
						onChangeText={(value) => setFeedback(draftKey, value)}
						editable={busy === null}
						multiline
					/>
					<CompactAction
						label={hasFeedback ? "Send" : "Abandon"}
						busy={busy === (hasFeedback ? "feedback" : "abandon")}
						disabled={busy !== null}
						onPress={() => void run(hasFeedback ? "feedback" : "abandon")}
					/>
				</View>
			</GlassSurface>
		</View>
	);
}

const ActionButton = ({
	label,
	primary,
	disabled,
	busy,
	onPress,
}: {
	label: string;
	primary?: boolean;
	disabled?: boolean;
	busy: boolean;
	onPress: () => void;
}) => (
	<Pressable
		accessibilityRole="button"
		accessibilityLabel={label}
		disabled={disabled === true || busy}
		onPress={onPress}
		className="h-11 items-center justify-center active:opacity-70"
		style={{ borderCurve: "continuous", opacity: disabled ? 0.4 : 1 }}
	>
		<View
			className={`h-10 w-full items-center justify-center rounded-full ${primary ? "bg-primary" : "border border-border bg-card"}`}
		>
			{busy ? (
				<ActivityIndicator
					color={primary ? colors.primaryForeground : colors.fg}
				/>
			) : (
				<Text
					className={`font-sans-medium text-[14px] ${primary ? "text-primary-foreground" : "text-foreground"}`}
				>
					{label}
				</Text>
			)}
		</View>
	</Pressable>
);

const CompactAction = ({
	label,
	busy,
	disabled,
	onPress,
}: {
	label: string;
	busy: boolean;
	disabled: boolean;
	onPress: () => void;
}) => (
	<Pressable
		accessibilityRole="button"
		accessibilityLabel={label}
		disabled={disabled}
		onPress={onPress}
		className="h-11 min-w-20 items-center justify-center active:opacity-70"
		style={{ borderCurve: "continuous", opacity: disabled ? 0.45 : 1 }}
	>
		<View className="h-10 min-w-20 items-center justify-center rounded-full border border-border bg-card px-4">
			{busy ? (
				<ActivityIndicator color={colors.fg} />
			) : (
				<Text className="font-sans-medium text-[14px] text-foreground">
					{label}
				</Text>
			)}
		</View>
	</Pressable>
);

const planReviewDraftsAtom = Atom.make<Record<string, string>>({}).pipe(
	Atom.keepAlive,
);
const planReviewDraftAtom = Atom.family((key: string) =>
	Atom.make((get) => get(planReviewDraftsAtom)[key] ?? ""),
);
const setFeedback = (key: string, value: string): void => {
	appAtomRegistry.update(planReviewDraftsAtom, (state) => ({
		...state,
		[key]: value,
	}));
};
