import type { UserQuestion } from "@zuse/contracts";
import { ArrowLeft, ArrowRight, Check, Send, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { colors } from "~/theme";

export type QuestionAnswer = {
	questionIndex: number;
	selected: readonly number[];
	other?: string;
};

type Draft = { selected: readonly number[]; other: string };

const preservedDrafts = new Map<string, readonly Draft[]>();

const emptyDraft = (): Draft => ({ selected: [], other: "" });

const complete = (
	questions: readonly UserQuestion[],
	drafts: readonly Draft[],
) =>
	questions.every(
		(_, index) =>
			(drafts[index]?.selected.length ?? 0) > 0 ||
			(drafts[index]?.other.trim().length ?? 0) > 0,
	);

export const PendingUserInputCard = ({
	itemId,
	questions,
	onSubmit,
}: {
	itemId: string;
	questions: readonly UserQuestion[];
	onSubmit: (
		itemId: string,
		answers: readonly QuestionAnswer[],
	) => void | Promise<void>;
}) => {
	const [activeIndex, setActiveIndex] = useState(0);
	const [drafts, setDrafts] = useState<readonly Draft[]>(
		() => preservedDrafts.get(itemId) ?? questions.map(emptyDraft),
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const active = questions[activeIndex];
	const draft = drafts[activeIndex] ?? emptyDraft();
	const isComplete = useMemo(
		() => complete(questions, drafts),
		[drafts, questions],
	);

	if (active === undefined) return null;

	const submitWith = async (nextDrafts: readonly Draft[]) => {
		if (submitting || !complete(questions, nextDrafts)) return;
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(
				itemId,
				nextDrafts.map((item, questionIndex) => ({
					questionIndex,
					selected: item.selected,
					...(item.other.trim().length > 0 ? { other: item.other.trim() } : {}),
				})),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setSubmitting(false);
		}
	};

	const commit = (next: Draft, advance: boolean) => {
		const nextDrafts = drafts.map((item, index) =>
			index === activeIndex ? next : item,
		);
		setDrafts(nextDrafts);
		preservedDrafts.set(itemId, nextDrafts);
		if (!advance) return;
		if (activeIndex === questions.length - 1) {
			void submitWith(nextDrafts);
		} else {
			setActiveIndex((index) => index + 1);
		}
	};

	const toggle = (optionIndex: number) => {
		if (active.multiSelect === true) {
			const selected = draft.selected.includes(optionIndex)
				? draft.selected.filter((index) => index !== optionIndex)
				: [...draft.selected, optionIndex];
			commit({ ...draft, selected }, false);
			return;
		}
		commit({ selected: [optionIndex], other: "" }, true);
	};

	const dismiss = async () => {
		if (submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(
				itemId,
				questions.map((_, questionIndex) => ({
					questionIndex,
					selected: [],
				})),
			);
			preservedDrafts.delete(itemId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setSubmitting(false);
		}
	};

	return (
		<View className="px-2 py-2">
			<View
				className="rounded-3xl border border-border bg-card px-4 py-4"
				style={{ borderCurve: "continuous" }}
			>
				<View className="flex-row items-start gap-3">
					<Text
						selectable
						className="min-w-0 flex-1 font-sans-medium text-[17px] leading-6 text-foreground"
					>
						{active.question}
					</Text>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Dismiss question"
						disabled={submitting}
						className="h-11 w-11 items-center justify-center active:opacity-60"
						onPress={() => void dismiss()}
					>
						<X size={18} color={colors.secondaryFg} />
					</Pressable>
				</View>

				<View className="pt-2">
					{active.options.map((option, optionIndex) => {
						const selected = draft.selected.includes(optionIndex);
						return (
							<Pressable
								key={`${itemId}:${active.question}:${option}`}
								accessibilityRole={active.multiSelect ? "checkbox" : "radio"}
								accessibilityState={{ checked: selected }}
								disabled={submitting}
								className="min-h-12 flex-row items-center gap-3 rounded-2xl px-2 active:opacity-60"
								style={{
									backgroundColor: selected
										? colors.cardElevated
										: "transparent",
								}}
								onPress={() => toggle(optionIndex)}
							>
								<Text
									className="w-5 text-right font-sans text-[12px] text-muted-foreground"
									style={{ fontVariant: ["tabular-nums"] }}
								>
									{optionIndex + 1}
								</Text>
								<Text
									selectable
									className="min-w-0 flex-1 font-sans text-[15px] leading-5 text-foreground"
								>
									{option}
								</Text>
								{selected ? <Check size={17} color={colors.accent} /> : null}
							</Pressable>
						);
					})}
					<View className="min-h-12 flex-row items-center gap-3 px-2">
						<Text className="w-5 text-right font-sans text-[12px] text-muted-foreground">
							0
						</Text>
						<TextInput
							accessibilityLabel="Other answer"
							className="min-h-11 min-w-0 flex-1 font-sans text-[16px] text-foreground"
							placeholder="Type another answer…"
							placeholderTextColor={colors.tertiaryFg}
							returnKeyType="done"
							editable={!submitting}
							value={draft.other}
							onChangeText={(other) => commit({ selected: [], other }, false)}
							onSubmitEditing={() => {
								const other = draft.other.trim();
								if (other.length > 0) commit({ selected: [], other }, true);
							}}
						/>
					</View>
				</View>

				{error === null ? null : (
					<Text
						selectable
						className="pt-2 font-sans text-[13px] leading-5 text-danger"
					>
						{error}
					</Text>
				)}

				<View className="min-h-12 flex-row items-center pt-2">
					{questions.length > 1 ? (
						<>
							<QuestionNav
								label="Previous question"
								disabled={activeIndex === 0 || submitting}
								onPress={() =>
									setActiveIndex((index) => Math.max(0, index - 1))
								}
								direction="previous"
							/>
							<Text
								className="px-2 font-sans text-[12px] text-muted-foreground"
								style={{ fontVariant: ["tabular-nums"] }}
							>
								{activeIndex + 1} of {questions.length}
							</Text>
							<QuestionNav
								label="Next question"
								disabled={activeIndex === questions.length - 1 || submitting}
								onPress={() =>
									setActiveIndex((index) =>
										Math.min(questions.length - 1, index + 1),
									)
								}
								direction="next"
							/>
						</>
					) : null}
					<View className="flex-1" />
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Submit answers"
						accessibilityState={{ disabled: !isComplete || submitting }}
						disabled={!isComplete || submitting}
						className="h-11 w-11 items-center justify-center rounded-full active:opacity-60"
						style={{
							backgroundColor: isComplete ? colors.fg : colors.cardElevated,
							opacity: submitting ? 0.45 : 1,
						}}
						onPress={() => void submitWith(drafts)}
					>
						<Send
							size={17}
							color={isComplete ? colors.primaryForeground : colors.tertiaryFg}
						/>
					</Pressable>
				</View>
			</View>
		</View>
	);
};

function QuestionNav({
	label,
	disabled,
	onPress,
	direction,
}: {
	label: string;
	disabled: boolean;
	onPress: () => void;
	direction: "previous" | "next";
}) {
	const Icon = direction === "previous" ? ArrowLeft : ArrowRight;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			disabled={disabled}
			className="h-11 w-11 items-center justify-center active:opacity-60"
			style={{ opacity: disabled ? 0.3 : 1 }}
			onPress={onPress}
		>
			<Icon size={17} color={colors.secondaryFg} />
		</Pressable>
	);
}
