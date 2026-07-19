import type {
	QueuedMessage,
	ThreadGoal,
	ThreadGoalSetInput,
} from "@zuse/contracts";
import { ArrowDown, ArrowUp, Send, Trash2, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
	Modal,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";

import { GlassSurface } from "~/components/ui/glass-surface";
import type { QueuedMessage as LocalQueuedMessage } from "~/offline/cache";
import { colors } from "~/theme";

export function ChatManagementBars({
	goal,
	planBlocked,
	queue,
	queueCount,
	localQueue,
	queuePaused,
	onSetGoal,
	onClearGoal,
	onDeleteQueue,
	onUpdateQueue,
	onSendQueue,
	onMoveQueue,
	onResumeQueue,
	onDeleteLocalQueue,
	onUpdateLocalQueue,
}: {
	goal: ThreadGoal | null;
	planBlocked: boolean;
	queue: readonly QueuedMessage[];
	queueCount: number;
	localQueue: readonly LocalQueuedMessage[];
	queuePaused: boolean;
	onSetGoal: (goal: ThreadGoalSetInput) => Promise<void>;
	onClearGoal: () => Promise<void>;
	onDeleteQueue: (id: string) => Promise<void>;
	onUpdateQueue: (item: QueuedMessage, text: string) => Promise<void>;
	onSendQueue: (id: string) => Promise<void>;
	onMoveQueue: (id: string, direction: -1 | 1) => Promise<void>;
	onResumeQueue: () => Promise<void>;
	onDeleteLocalQueue: (id: string) => Promise<void>;
	onUpdateLocalQueue: (id: string, text: string) => Promise<void>;
}) {
	const [goalOpen, setGoalOpen] = useState(false);
	const [queueOpen, setQueueOpen] = useState(false);
	return (
		<>
			<View className="mb-2 items-center gap-2">
				{goal ? (
					<CompactBar
						label={
							goal.status === "active"
								? goal.objective
								: `${goalStatus(goal.status)} · ${goal.objective}`
						}
						onPress={() => setGoalOpen(true)}
					/>
				) : null}
				{queueCount > 0 || queuePaused ? (
					<CompactBar
						label={`${queueCount} queued${queuePaused ? " · paused" : ""}`}
						onPress={() => setQueueOpen(true)}
					/>
				) : null}
			</View>
			<GoalSheet
				open={goalOpen}
				onClose={() => setGoalOpen(false)}
				goal={goal}
				planBlocked={planBlocked}
				onSetGoal={onSetGoal}
				onClearGoal={onClearGoal}
			/>
			<QueueSheet
				open={queueOpen}
				onClose={() => setQueueOpen(false)}
				items={queue}
				localItems={localQueue}
				paused={queuePaused}
				onDelete={onDeleteQueue}
				onUpdate={onUpdateQueue}
				onSend={onSendQueue}
				onMove={onMoveQueue}
				onResume={onResumeQueue}
				onDeleteLocal={onDeleteLocalQueue}
				onUpdateLocal={onUpdateLocalQueue}
			/>
		</>
	);
}

const CompactBar = ({
	label,
	onPress,
}: {
	label: string;
	onPress: () => void;
}) => (
	<Pressable
		accessibilityRole="button"
		accessibilityLabel={label}
		onPress={onPress}
		className="min-h-11 max-w-[86%] justify-center active:opacity-70"
	>
		<GlassSurface
			style={{
				minHeight: 44,
				justifyContent: "center",
				paddingHorizontal: 16,
				borderRadius: 22,
			}}
		>
			<Text
				className="font-sans-medium text-[14px] text-foreground"
				numberOfLines={1}
			>
				{label}
			</Text>
		</GlassSurface>
	</Pressable>
);

const SheetFrame = ({
	open,
	onClose,
	title,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
}) => (
	<Modal
		visible={open}
		animationType="slide"
		presentationStyle="formSheet"
		onRequestClose={onClose}
	>
		<View className="flex-1 bg-background">
			<View className="flex-row items-center border-b border-border px-4 py-3">
				<Text className="flex-1 font-sans-bold text-xl text-foreground">
					{title}
				</Text>
				<IconButton label="Close" onPress={onClose}>
					<X size={20} color={colors.fg} />
				</IconButton>
			</View>
			{children}
		</View>
	</Modal>
);

function GoalSheet({
	open,
	onClose,
	goal,
	planBlocked,
	onSetGoal,
	onClearGoal,
}: {
	open: boolean;
	onClose: () => void;
	goal: ThreadGoal | null;
	planBlocked: boolean;
	onSetGoal: (goal: ThreadGoalSetInput) => Promise<void>;
	onClearGoal: () => Promise<void>;
}) {
	const [objective, setObjective] = useState(goal?.objective ?? "");
	const [budget, setBudget] = useState(goal?.tokenBudget?.toString() ?? "");
	useEffect(() => {
		setObjective(goal?.objective ?? "");
		setBudget(goal?.tokenBudget?.toString() ?? "");
	}, [goal]);
	return (
		<SheetFrame open={open} onClose={onClose} title="Goal">
			<ScrollView
				contentContainerClassName="gap-5 p-5"
				keyboardShouldPersistTaps="handled"
			>
				{planBlocked ? (
					<Text className="font-sans text-sm text-muted-foreground">
						This goal resumes after the plan is resolved.
					</Text>
				) : null}
				<TextInput
					accessibilityLabel="Goal objective"
					value={objective}
					onChangeText={setObjective}
					multiline
					className="min-h-24 rounded-2xl border border-border bg-card p-4 font-sans text-base text-foreground"
					placeholder="Goal objective"
					placeholderTextColor={colors.tertiaryFg}
				/>
				<TextInput
					accessibilityLabel="Goal token budget"
					value={budget}
					onChangeText={setBudget}
					keyboardType="number-pad"
					className="h-12 rounded-xl border border-border bg-card px-4 font-sans text-base text-foreground"
					placeholder="Token budget (optional)"
					placeholderTextColor={colors.tertiaryFg}
				/>
				{goal ? (
					<Text className="font-sans text-sm text-muted-foreground">
						{goal.tokensUsed.toLocaleString()} tokens ·{" "}
						{Math.round(goal.timeUsedSeconds / 60)} min
					</Text>
				) : null}
				<Action
					label="Save goal"
					onPress={() =>
						void onSetGoal({
							objective: objective.trim(),
							tokenBudget: budget.trim() ? Number(budget) : null,
						})
					}
				/>
				{goal ? (
					<Action
						label={goal.status === "paused" ? "Resume" : "Pause"}
						onPress={() =>
							void onSetGoal({
								status: goal.status === "paused" ? "active" : "paused",
							})
						}
					/>
				) : null}
				{goal ? (
					<Action
						label="Clear goal"
						danger
						onPress={() => void onClearGoal().then(onClose)}
					/>
				) : null}
			</ScrollView>
		</SheetFrame>
	);
}

const QueueSheet = ({
	open,
	onClose,
	items,
	localItems,
	paused,
	onDelete,
	onUpdate,
	onSend,
	onMove,
	onResume,
	onDeleteLocal,
	onUpdateLocal,
}: {
	open: boolean;
	onClose: () => void;
	items: readonly QueuedMessage[];
	localItems: readonly LocalQueuedMessage[];
	paused: boolean;
	onDelete: (id: string) => Promise<void>;
	onUpdate: (item: QueuedMessage, text: string) => Promise<void>;
	onSend: (id: string) => Promise<void>;
	onMove: (id: string, direction: -1 | 1) => Promise<void>;
	onResume: () => Promise<void>;
	onDeleteLocal: (id: string) => Promise<void>;
	onUpdateLocal: (id: string, text: string) => Promise<void>;
}) => (
	<SheetFrame open={open} onClose={onClose} title="Queue">
		<ScrollView contentContainerClassName="gap-3 p-4">
			{paused ? (
				<Action label="Resume queue" onPress={() => void onResume()} />
			) : null}
			{items.map((item, index) => (
				<QueueItem
					key={item.id}
					item={item}
					index={index}
					count={items.length}
					onDelete={onDelete}
					onUpdate={onUpdate}
					onSend={onSend}
					onMove={onMove}
				/>
			))}
			{localItems.map((item) => (
				<LocalQueueItem
					key={item.clientId}
					item={item}
					onDelete={onDeleteLocal}
					onUpdate={onUpdateLocal}
				/>
			))}
			{items.length === 0 && localItems.length === 0 ? (
				<Text className="p-6 text-center font-sans text-muted-foreground">
					The queue is empty.
				</Text>
			) : null}
		</ScrollView>
	</SheetFrame>
);

function LocalQueueItem({
	item,
	onDelete,
	onUpdate,
}: {
	item: LocalQueuedMessage;
	onDelete: (id: string) => Promise<void>;
	onUpdate: (id: string, text: string) => Promise<void>;
}) {
	const [text, setText] = useState(item.text);
	return (
		<View className="rounded-2xl border border-border bg-card p-4">
			<TextInput
				accessibilityLabel="Offline queued message"
				value={text}
				onChangeText={setText}
				onBlur={() => {
					if (text.trim() !== item.text)
						void onUpdate(item.clientId, text.trim());
				}}
				multiline
				className="font-sans text-[15px] leading-5 text-foreground"
			/>
			<View className="mt-3 flex-row items-center justify-between">
				<Text className="font-sans text-xs text-muted-foreground">
					{item.asGoal ? "Goal · " : ""}Waiting for connection
				</Text>
				<IconButton label="Delete" onPress={() => void onDelete(item.clientId)}>
					<Trash2 size={18} color={colors.danger} />
				</IconButton>
			</View>
		</View>
	);
}

function QueueItem({
	item,
	index,
	count,
	onDelete,
	onUpdate,
	onSend,
	onMove,
}: {
	item: QueuedMessage;
	index: number;
	count: number;
	onDelete: (id: string) => Promise<void>;
	onUpdate: (item: QueuedMessage, text: string) => Promise<void>;
	onSend: (id: string) => Promise<void>;
	onMove: (id: string, direction: -1 | 1) => Promise<void>;
}) {
	const [text, setText] = useState(item.input.text);
	return (
		<View className="rounded-2xl border border-border bg-card p-4">
			<TextInput
				accessibilityLabel="Queued message"
				value={text}
				onChangeText={setText}
				onBlur={() => {
					if (text.trim() !== item.input.text) void onUpdate(item, text.trim());
				}}
				multiline
				className="font-sans text-[15px] leading-5 text-foreground"
				placeholder="Attachment"
				placeholderTextColor={colors.tertiaryFg}
			/>
			<Text className="mt-2 font-sans text-xs text-muted-foreground">
				{item.input.asGoal ? "Goal · " : ""}
				{item.input.attachments.length} attachments ·{" "}
				{item.input.fileRefs.length + item.input.skillRefs.length} references
			</Text>
			<View className="mt-3 flex-row justify-end gap-1">
				<IconButton
					label="Move up"
					disabled={index === 0}
					onPress={() => void onMove(item.id, -1)}
				>
					<ArrowUp size={18} color={colors.fg} />
				</IconButton>
				<IconButton
					label="Move down"
					disabled={index === count - 1}
					onPress={() => void onMove(item.id, 1)}
				>
					<ArrowDown size={18} color={colors.fg} />
				</IconButton>
				<IconButton label="Send now" onPress={() => void onSend(item.id)}>
					<Send size={18} color={colors.fg} />
				</IconButton>
				<IconButton label="Delete" onPress={() => void onDelete(item.id)}>
					<Trash2 size={18} color={colors.danger} />
				</IconButton>
			</View>
		</View>
	);
}

const IconButton = ({
	label,
	disabled,
	onPress,
	children,
}: {
	label: string;
	disabled?: boolean;
	onPress: () => void;
	children: React.ReactNode;
}) => (
	<Pressable
		accessibilityRole="button"
		accessibilityLabel={label}
		disabled={disabled}
		onPress={onPress}
		className="h-11 w-11 items-center justify-center rounded-full active:bg-card-elevated"
		style={{ opacity: disabled ? 0.35 : 1 }}
	>
		{children}
	</Pressable>
);
const Action = ({
	label,
	danger,
	onPress,
}: {
	label: string;
	danger?: boolean;
	onPress: () => void;
}) => (
	<Pressable
		accessibilityRole="button"
		accessibilityLabel={label}
		onPress={onPress}
		className="h-12 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
	>
		<Text
			className={`font-sans-medium text-base ${danger ? "text-danger" : "text-foreground"}`}
		>
			{label}
		</Text>
	</Pressable>
);
const goalStatus = (status: ThreadGoal["status"]): string =>
	({
		active: "Active",
		paused: "Paused",
		budgetLimited: "Budget reached",
		usageLimited: "Usage limited",
		blocked: "Blocked",
		complete: "Complete",
	})[status];
