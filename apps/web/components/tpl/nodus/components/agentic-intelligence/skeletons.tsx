"use client";
import { IconCheck, IconTerminal2 } from "@tabler/icons-react";
import { motion } from "motion/react";
import Image from "next/image";
import { useEffect, useId, useState } from "react";
import { useTypewriter } from "@/components/tpl/nodus/hooks/use-typewriter";
import {
	AttachmentIcon,
	CodeIcon,
	IntegrationsLogo,
	SendIcon,
	WindowIcon,
} from "@/components/tpl/nodus/icons/bento-icons";
import {
	AnthropicLogo,
	OpenAILogo,
} from "@/components/tpl/nodus/icons/general";
import { cn } from "@/components/tpl/nodus/lib/utils";
import { IconBlock } from "../common/icon-block";
import { DivideX } from "../divide";
import { LogoSVG } from "../logo";

export const WorkspaceSessionSkeleton = () => {
	const models = [
		{
			name: "Claude Code",
			logo: AnthropicLogo,
			status: "Running",
			variant: "success",
		},
		{
			name: "Codex",
			logo: OpenAILogo,
			status: "Reviewing",
			variant: "warning",
		},
		{
			name: "CI checks",
			logo: OpenAILogo,
			status: "Passed",
			variant: "success",
		},
	];
	return (
		<motion.div className="border-border bg-card relative mx-auto mt-20 h-full max-h-70 min-h-40 w-[85%] rounded-2xl border-t p-4 shadow-2xl">
			<motion.div
				initial={{ opacity: 0 }}
				whileInView={{ opacity: 1 }}
				viewport={{ once: true }}
				transition={{ duration: 1, delay: 1.5 }}
				className="bg-card absolute -top-10 -right-10 z-20 flex w-40 shrink-0 flex-col items-start rounded-lg text-xs shadow-sm"
			>
				<div className="flex w-full items-center justify-between p-2">
					<div className="flex items-center gap-2 font-medium">
						<OpenAILogo />
						Fresh worktree
					</div>
					<p className="text-muted-foreground font-mono">main</p>
				</div>
				<DivideX />
				<div className="m-2 rounded-sm border border-blue-500 bg-blue-50 px-2 py-0.5 text-blue-500 dark:bg-blue-50/10">
					Created
				</div>
			</motion.div>
			<div className="mb-4 flex gap-2">
				<div className="h-3 w-3 rounded-full bg-red-500"></div>
				<div className="h-3 w-3 rounded-full bg-yellow-500"></div>
				<div className="h-3 w-3 rounded-full bg-green-500"></div>
			</div>
			<div className="mt-12 flex items-center gap-2">
				<IntegrationsLogo />
				<span className="text-heading text-sm font-medium">
					checkout-recovery
				</span>
				<span className="border-border bg-elevated text-heading rounded-lg border px-2 py-0.5 text-xs">
					2 sessions
				</span>
			</div>
			<DivideX className="mt-2" />
			{models.map((model, index) => (
				<div className="relative" key={model.name}>
					<motion.div
						key={model.name}
						className="mt-4 flex items-center justify-between gap-2"
						initial={{ opacity: 0, x: -12 }}
						whileInView={{ opacity: 1, x: 0 }}
						viewport={{ once: true }}
						transition={{
							duration: 1,
							delay: index * 1,
							ease: "easeInOut",
						}}
					>
						<div className="flex items-center gap-2">
							<model.logo className="h-4 w-4 shrink-0" />
							<span className="text-heading text-sm font-medium">
								{model.name}
							</span>
						</div>

						<div
							className={cn(
								"rounded-sm border px-2 py-0.5 text-xs",
								model.variant === "success" &&
									"border-emerald-500 bg-emerald-50 text-emerald-500 dark:bg-emerald-50/10",
								model.variant === "warning" &&
									"border-yellow-500 bg-yellow-50 text-yellow-500 dark:bg-yellow-50/10",
								model.variant === "danger" &&
									"border-red-500 bg-red-50 text-red-500 dark:bg-red-50/10",
							)}
						>
							{model.status}
						</div>
					</motion.div>
					<motion.div
						initial={{ x: 0, opacity: 0 }}
						whileInView={{
							x: "100%",
							opacity: [0, 1, 1, 1, 0],
						}}
						viewport={{ once: true }}
						transition={{
							x: {
								duration: 1,
								delay: index * 1,
								ease: "easeInOut",
							},
							opacity: {
								duration: 1,
								delay: index * 1,
								ease: "easeInOut",
							},
						}}
						className="absolute inset-y-0 left-0 h-full w-[2px] bg-gradient-to-t from-transparent via-blue-500 to-transparent"
					>
						{[
							{
								id: "north",
								x: -32,
								y: -18,
								delay: 0.1,
								duration: 0.7,
								scale: 0.7,
							},
							{
								id: "east",
								x: 24,
								y: -31,
								delay: 0.2,
								duration: 0.9,
								scale: 0.8,
							},
							{
								id: "south",
								x: -18,
								y: 28,
								delay: 0.3,
								duration: 0.8,
								scale: 0.6,
							},
							{ id: "west", x: 38, y: 18, delay: 0.4, duration: 1, scale: 0.9 },
						].map((sparkle) => (
							<motion.div
								key={sparkle.id}
								initial={{
									opacity: 0,
									scale: 0,
									x: 0,
									y: 0,
								}}
								whileInView={{
									opacity: [0, 1, 0],
									scale: [0, sparkle.scale, 0],
									x: sparkle.x,
									y: sparkle.y,
									rotate: [0, 360],
								}}
								viewport={{ once: true }}
								transition={{
									duration: sparkle.duration,
									delay: index * 1 + sparkle.delay,
									ease: "easeOut",
								}}
								className="absolute top-1/2 left-1/2 h-1 w-1 text-xs text-blue-400"
							>
								✨
							</motion.div>
						))}
					</motion.div>
				</div>
			))}
		</motion.div>
	);
};

const TYPING_SPEED = 30;

export const CliSessionSkeleton = () => {
	const initialChat = [
		{
			role: "user",
			content:
				'zuse chat create --project zuse --workspace fresh --provider claude --prompt "Implement checkout recovery"',
		},
		{
			role: "assistant",
			content:
				"Worktree created. Claude Code is implementing checkout recovery.",
		},
		{
			role: "user",
			content:
				'zuse session create --project zuse --chat checkout-recovery --provider codex --prompt "Review the diff"',
		},
		{
			role: "assistant",
			content: "Codex started in the same chat and worktree.",
		},
	];

	const [chat, setChat] = useState(initialChat);
	const [inputText, setInputText] = useState("");
	const [visibleMessages, setVisibleMessages] = useState(0);
	const [currentMessageComplete, setCurrentMessageComplete] = useState(false);
	const [chatContainerRef, setChatContainerRef] =
		useState<HTMLDivElement | null>(null);

	const INITIAL_DELAY = 200;
	const MESSAGE_DELAY = 400;
	const handleSendMessage = () => {
		if (inputText.trim()) {
			const newMessages = [
				...chat,
				{
					role: "user",
					content: inputText.trim(),
				},
				{
					role: "assistant",
					content:
						"Session started in checkout-recovery with the current diff and test evidence.",
				},
			];
			setChat(newMessages);
			setVisibleMessages(newMessages.length);
			setInputText("");
			setCurrentMessageComplete(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			handleSendMessage();
		}
	};

	useEffect(() => {
		const timer = setTimeout(() => {
			setVisibleMessages(1);
		}, INITIAL_DELAY);

		return () => clearTimeout(timer);
	}, []);

	useEffect(() => {
		if (currentMessageComplete && visibleMessages < chat.length) {
			const timer = setTimeout(() => {
				setVisibleMessages((prev) => prev + 1);
				setCurrentMessageComplete(false);
			}, MESSAGE_DELAY);

			return () => clearTimeout(timer);
		}
	}, [currentMessageComplete, visibleMessages, chat.length]);

	useEffect(() => {
		if (chatContainerRef) {
			chatContainerRef.scrollTo({
				top: chatContainerRef.scrollHeight,
				behavior: "smooth",
			});
		}
	}, [chatContainerRef]);

	return (
		<motion.div className="relative mx-auto mt-2 h-full max-h-70 min-h-40 w-[85%] p-4">
			<div className="border-border bg-card absolute inset-x-0 -bottom-4 mx-auto flex w-[85%] items-center justify-between rounded-lg border shadow-[0px_2px_12px_0px_rgba(0,0,0,0.08)]">
				<input
					type="text"
					value={inputText}
					onChange={(e) => setInputText(e.target.value)}
					onKeyDown={handleKeyDown}
					className="text-heading min-w-0 flex-1 border-none bg-transparent px-4 py-4 text-xs placeholder:text-muted-foreground focus:outline-none"
					placeholder="Run a Zuse CLI command"
				/>
				<div className="mr-4 flex items-center gap-2">
					<AttachmentIcon />
					<button
						type="button"
						aria-label="Run command"
						onClick={handleSendMessage}
						className="grid size-11 cursor-pointer place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
					>
						<SendIcon />
					</button>
				</div>
			</div>
			<div
				ref={setChatContainerRef}
				className="mask-bg-gradient-to-b flex max-h-[calc(100%-1rem)] flex-col gap-4 overflow-y-auto from-white to-transparent mask-t-from-70% mask-b-from-70% pt-4 pb-16 dark:from-neutral-900 dark:to-transparent"
				style={{
					scrollbarWidth: "none",
					msOverflowStyle: "none",
				}}
			>
				{chat.slice(0, visibleMessages).map((message, index) => (
					<motion.div
						key={`${message.role}-${message.content}`}
						initial={{ opacity: 0, y: 20 }}
						whileInView={{ opacity: 1, y: 0 }}
						viewport={{ once: true }}
						transition={{ duration: 0.3 }}
					>
						{message.role === "user" ? (
							<UserMessage
								content={message.content}
								isActive={index === visibleMessages - 1}
								onComplete={() => setCurrentMessageComplete(true)}
							/>
						) : (
							<AssistantMessage
								content={message.content}
								isActive={index === visibleMessages - 1}
								onComplete={() => setCurrentMessageComplete(true)}
							/>
						)}
					</motion.div>
				))}
			</div>
		</motion.div>
	);
};

const UserMessage = ({
	content,
	isActive,
	onComplete,
}: {
	content: string;
	isActive: boolean;
	onComplete: () => void;
}) => {
	const { displayText, isComplete } = useTypewriter(content, TYPING_SPEED);

	useEffect(() => {
		if (isComplete && isActive) {
			onComplete();
		}
	}, [isComplete, isActive, onComplete]);

	return (
		<div className="flex justify-end gap-3">
			<div className="flex max-w-xs flex-col gap-1">
				<div className="rounded-2xl rounded-br-md bg-blue-500 px-4 py-2 text-sm text-white">
					{isActive ? displayText : content}
					{isActive && !isComplete && <span className="animate-pulse">|</span>}
				</div>
			</div>
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-black">
				<IconTerminal2 className="size-4" />
			</div>
		</div>
	);
};

const AssistantMessage = ({
	content,
	isActive,
	onComplete,
}: {
	content: string;
	isActive: boolean;
	onComplete: () => void;
}) => {
	const { displayText, isComplete } = useTypewriter(content, TYPING_SPEED);

	useEffect(() => {
		if (isComplete && isActive) {
			onComplete();
		}
	}, [isComplete, isActive, onComplete]);

	return (
		<div className="flex gap-3 px-1">
			<div className="border-border bg-card flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-medium shadow-sm">
				<LogoSVG className="size-4 text-black dark:text-white" />
			</div>
			<div className="flex max-w-xs flex-col gap-1">
				<div className="bg-elevated text-heading rounded-2xl rounded-bl-md px-4 py-2 text-sm">
					{isActive ? displayText : content}
					{isActive && !isComplete && <span className="animate-pulse">|</span>}
				</div>
			</div>
		</div>
	);
};

export const AgentActivityGraphSkeleton = () => {
	const mobileStages = [
		{ icon: WindowIcon, label: "Claude · implementation", status: "Running" },
		{ icon: CodeIcon, label: "Codex · diff review", status: "Reviewing" },
		{ icon: IconCheck, label: "CI logs · attached", status: "Ready" },
	];
	return (
		<>
			<div className="border-border bg-card relative mx-4 my-8 overflow-hidden rounded-2xl border p-4 shadow-xl lg:hidden">
				<div className="mb-4 flex items-center justify-between gap-3">
					<div>
						<p className="text-heading text-sm font-medium">Same worktree</p>
						<p className="text-xs text-gray-500 dark:text-neutral-400">
							agent/checkout-recovery
						</p>
					</div>
					<span className="rounded-sm border border-blue-500 bg-blue-50 px-2 py-1 text-xs text-blue-600 dark:bg-blue-900/40 dark:text-blue-300">
						Connected
					</span>
				</div>
				<div className="space-y-2">
					{mobileStages.map((stage) => (
						<div
							key={stage.label}
							className="border-border bg-elevated flex min-h-12 items-center gap-3 rounded-lg border px-3"
						>
							<stage.icon className="size-4 shrink-0 text-blue-500" />
							<span className="text-heading min-w-0 flex-1 text-sm">
								{stage.label}
							</span>
							<span className="text-xs text-gray-500 dark:text-neutral-400">
								{stage.status}
							</span>
						</div>
					))}
				</div>
				<div
					className="mt-4 flex items-center justify-center gap-3"
					role="img"
					aria-label="Claude Code to Codex to GitHub evidence flow"
				>
					<IconBlock
						icon={
							<Image
								src="/logos/claude.svg"
								alt="Claude Code"
								width={24}
								height={24}
								className="size-6"
							/>
						}
					/>
					<span className="text-gray-400" aria-hidden="true">
						→
					</span>
					<IconBlock
						icon={
							<Image
								src="/logos/openai.svg"
								alt="Codex"
								width={24}
								height={24}
								className="size-6"
							/>
						}
					/>
					<span className="text-gray-400" aria-hidden="true">
						→
					</span>
					<IconBlock
						icon={
							<Image
								src="/logos/github.svg"
								alt="GitHub"
								width={24}
								height={24}
								className="size-6"
							/>
						}
					/>
				</div>
			</div>
			<motion.div className="relative mx-auto my-12 hidden h-full max-h-70 min-h-80 max-w-[67rem] grid-cols-2 p-4 lg:grid">
				<div className="flex items-center justify-between">
					<div className="flex flex-col gap-10">
						<TextIconBlock icon={<WindowIcon />} text="Claude · implementation">
							<TopSVG className="absolute top-2 -right-84" />
						</TextIconBlock>
						<TextIconBlock icon={<CodeIcon />} text="Codex · diff review">
							<MiddleSVG className="absolute top-2 -right-84" />
						</TextIconBlock>
						<TextIconBlock icon={<IconCheck />} text="CI logs · attached">
							<BottomSVG className="absolute -right-84 bottom-2" />
						</TextIconBlock>
					</div>
					<div className="relative h-16 w-16 overflow-hidden rounded-md bg-gray-200 p-px shadow-xl dark:bg-neutral-700">
						<div className="absolute inset-0 scale-[1.4] animate-spin rounded-full bg-conic [background-image:conic-gradient(at_center,transparent,var(--color-blue-500)_20%,transparent_30%)] [animation-duration:2s]"></div>
						<div className="absolute inset-0 scale-[1.4] animate-spin rounded-full [background-image:conic-gradient(at_center,transparent,var(--color-brand)_20%,transparent_30%)] [animation-delay:1s] [animation-duration:2s]"></div>
						<div className="relative z-20 flex h-full w-full items-center justify-center rounded-[5px] bg-white dark:bg-neutral-900">
							<LogoSVG className="text-black dark:text-white" />
						</div>
					</div>
				</div>
				<div className="relative flex h-full w-full items-center justify-start">
					<RightSideSVG />
					<div className="relative flex flex-col items-center gap-2">
						<span className="relative z-20 rounded-sm border border-blue-500 bg-blue-50 px-2 py-0.5 text-xs text-blue-500 dark:bg-blue-900 dark:text-white">
							Connected
						</span>
						<div className="absolute inset-x-0 -top-30 flex h-full flex-col items-center">
							<IconBlock
								icon={
									<Image
										src="/logos/claude.svg"
										alt="Claude Code"
										width={24}
										height={24}
										className="size-6"
									/>
								}
							/>
							<VerticalLine />
							<VerticalLine />
							<IconBlock
								icon={
									<Image
										src="/logos/github.svg"
										alt="GitHub"
										width={24}
										height={24}
										className="size-6"
									/>
								}
							/>
						</div>
					</div>
					<div className="2 absolute -top-4 right-30 flex h-full flex-col items-center">
						<IconBlock
							icon={
								<Image
									src="/logos/openai.svg"
									alt="Codex"
									width={24}
									height={24}
									className="size-6"
								/>
							}
						/>
						<VerticalLine />
						<IconBlock
							icon={
								<Image
									src="/logos/linear.svg"
									alt="Linear"
									width={24}
									height={24}
									className="size-6"
								/>
							}
						/>
					</div>
					<RightSideSVG />
					<IconBlock icon={<OpenAILogo className="size-6" />} />
				</div>
			</motion.div>
		</>
	);
};
const VerticalLine = (
	props: React.SVGProps<SVGSVGElement> & { stopColor?: string },
) => {
	const gradientId = useId();
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="1"
			height="81"
			viewBox="0 0 1 81"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className="shrink-0"
			{...props}
		>
			<line
				y1="-0.5"
				x2="80"
				y2="-0.5"
				transform="matrix(0 -1 -1 0 0 80.5)"
				stroke="var(--color-line)"
			/>
			<line
				y1="-0.5"
				x2="80"
				y2="-0.5"
				transform="matrix(0 -1 -1 0 0 80.5)"
				stroke={`url(#${gradientId})`}
			/>
			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						x1: 0,
						x2: 2,
						y1: "0%",
						y2: "0%",
					}}
					animate={{
						x1: 0,
						x2: 2,
						y1: "80%",
						y2: "100%",
					}}
					transition={{
						duration: 4,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="var(--color-line)" />
					<stop offset="0.5" stopColor="#F17463" />
					<stop offset="1" stopColor="var(--color-line)" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};

const RightSideSVG = (props: React.SVGProps<SVGSVGElement>) => {
	const gradientId = useId();
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="314"
			height="2"
			viewBox="0 0 314 2"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<line
				x1="0.5"
				y1="1"
				x2="313.5"
				y2="1"
				stroke="var(--color-line)"
				strokeLinecap="round"
			/>
			<line
				x1="0.5"
				y1="1"
				x2="313.5"
				y2="1"
				stroke={`url(#${gradientId})`}
				strokeLinecap="round"
			/>
			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						y1: 0,
						y2: 1,
						x1: "-10%",
						x2: "0%",
					}}
					animate={{
						y1: 0,
						y2: 1,
						x1: "110%",
						x2: "120%",
					}}
					transition={{
						duration: 2,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="var(--color-line)" />
					<stop offset="0.5" stopColor="var(--color-blue-500)" />
					<stop offset="1" stopColor="var(--color-line)" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};

const TopSVG = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="312"
			height="33"
			viewBox="0 0 312 33"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<line
				x1="0.5"
				y1="1"
				x2="311.5"
				y2="1"
				stroke="var(--color-line)"
				strokeLinecap="round"
			/>
			<line
				x1="311.5"
				y1="1"
				x2="311.5"
				y2="32"
				stroke="var(--color-line)"
				strokeLinecap="round"
			/>

			<line
				x1="0.5"
				y1="1"
				x2="311.5"
				y2="1"
				stroke="url(#line-one-gradient)"
				strokeLinecap="round"
			/>
			<defs>
				<motion.linearGradient
					gradientUnits="userSpaceOnUse"
					id="line-one-gradient"
					initial={{
						x1: "-20%",
						x2: "0%",
						y1: 1,
						y2: 0,
					}}
					animate={{
						x1: "105%",
						x2: "120%",
						y1: 1,
						y2: 0,
					}}
					transition={{
						duration: 2,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
				>
					<stop stopColor="var(--color-line)" />
					<stop offset="0.33" stopColor="#F17463" />
					<stop offset="0.66" stopColor="#F17463" />
					<stop offset="1" stopColor="var(--color-line)" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};

export const MiddleSVG = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="323"
			height="2"
			viewBox="0 0 323 2"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<line
				x1="0.5"
				y1="1"
				x2="322.5"
				y2="1"
				stroke="var(--color-line)"
				strokeLinecap="round"
			/>
			<line
				x1="0.5"
				y1="1"
				x2="322.5"
				y2="1"
				stroke="url(#line-two-gradient)"
				strokeLinecap="round"
			/>
			<defs>
				<motion.linearGradient
					gradientUnits="userSpaceOnUse"
					id="line-two-gradient"
					initial={{
						x1: "-20%",
						x2: "0%",
						y1: 1,
						y2: 0,
					}}
					animate={{
						x1: "105%",
						x2: "120%",
						y1: 1,
						y2: 0,
					}}
					transition={{
						duration: 2,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
				>
					<stop stopColor="var(--color-line)" />
					<stop offset="0.33" stopColor="var(--color-blue-500)" />
					<stop offset="0.66" stopColor="var(--color-blue-500)" />
					<stop offset="1" stopColor="var(--color-line)" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};

export const BottomSVG = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="326"
			height="32"
			viewBox="0 0 326 32"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<line y1="31" x2="325" y2="31" stroke="var(--color-line)" />

			<line
				x1="325.5"
				y1="31"
				x2="325.5"
				y2="1"
				stroke="var(--color-line)"
				strokeLinecap="round"
			/>
			<line y1="31" x2="325" y2="31" stroke="url(#line-three-gradient)" />

			<defs>
				<motion.linearGradient
					id="line-three-gradient"
					gradientUnits="userSpaceOnUse"
					initial={{
						x1: "-20%",
						x2: "0%",
						y1: 1,
						y2: 0,
					}}
					animate={{
						x1: "105%",
						x2: "120%",
					}}
					transition={{
						duration: 2,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
				>
					<stop stopColor="var(--color-line)" />
					<stop offset="0.33" stopColor="var(--color-yellow-500)" />
					<stop offset="0.66" stopColor="var(--color-yellow-500)" />
					<stop offset="1" stopColor="var(--color-line)" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};

const TextIconBlock = ({
	icon,
	text,
	children,
}: {
	icon: React.ReactNode;
	text: string;
	children?: React.ReactNode;
}) => {
	return (
		<div className="relative flex items-center gap-2">
			{icon}
			<span className="text-heading text-sm font-medium">{text}</span>
			{children}
		</div>
	);
};
