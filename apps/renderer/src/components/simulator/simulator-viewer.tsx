import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import {
	androidKeycode,
	SimulatorVideo,
	simulatorKeyUsage,
} from "@zuse/client-runtime/simulators/video";
import type {
	SimulatorInput,
	SimulatorState,
	SimulatorSummary,
} from "@zuse/contracts";
import {
	ArrowLeft01Icon,
	ArrowTurnBackwardIcon,
	Camera01Icon,
	DashboardSquare01Icon,
	Home01Icon,
	MoreHorizontalIcon,
	ScreenRotationIcon,
	Settings01Icon,
	ShutDownIcon,
	Unlink01Icon,
} from "@zuse/icons/solid-rounded";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { errorMessage } from "~/lib/error-message.ts";
import { getRendererClientBus } from "~/lib/session-timeline-client-bus.ts";
import {
	simulatorCommand,
	simulatorPoint,
	simulatorVideoKey,
	useSimulatorActions,
	useSimulatorVideo,
} from "~/lib/simulator-client-bus.ts";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui.ts";
import { DOCK_ICON_BUTTON_CLASS } from "../dock-panel/text.ts";
import { Button } from "../ui/button.tsx";
import {
	Menu,
	MenuCheckboxItem,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "../ui/menu.tsx";
import { Spinner } from "../ui/spinner.tsx";
import {
	openSimulatorSettings,
	SimulatorError,
	SimulatorIconAction,
} from "./simulator-parts.tsx";

/** Placeholder proportions until the first frame reports the real screen. */
const PHONE_ASPECT = { width: 390, height: 844 };
const MAX_PENDING_INPUT = 128;
const errorText = (error: unknown) =>
	errorMessage(error, "Simulator operation failed");

export function SimulatorViewer({
	refTarget,
	panelRef,
	panelId,
	device,
	state,
	active,
}: {
	refTarget: ChatRef;
	panelRef: ChatRef;
	panelId: string;
	device: SimulatorSummary;
	state: SimulatorState;
	active: boolean;
}) {
	const actions = useSimulatorActions(refTarget.environmentId);
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const [format, setFormat] = useState<"avcc" | "mjpeg">(() =>
		SimulatorVideo.supported() ? "avcc" : "mjpeg",
	);
	const android = device.platform === "android";
	// iOS falls back to JPEG frames; Android has only H.264, so it reports instead.
	const [decodeError, setDecodeError] = useState<string | null>(null);
	const fallback = useCallback(() => {
		if (android)
			setDecodeError(
				"This window couldn’t decode the emulator’s video. Reconnect to try again.",
			);
		else setFormat("mjpeg");
	}, [android]);
	const ref = useMemo(
		() => ({ ...refTarget, deviceId: device.id, format }),
		[refTarget.environmentId, refTarget.chatId, device.id, format],
	);
	const video = useSimulatorVideo(ref, canvas, active, fallback);
	const input = useSimulatorInput(ref, actions.setError);
	const { release } = input;
	useEffect(() => {
		if (!active) release();
	}, [active, release]);
	const [focused, setFocused] = useState(false);
	const [flash, setFlash] = useState(0);
	const stage = useRef<HTMLDivElement>(null);
	const screen = video.size ?? PHONE_ASPECT;
	const fit = useFit(stage, screen.width / screen.height);
	const streamError = video.view.data?.error ?? decodeError;
	const close = (shutdown: boolean) => {
		input.release();
		void actions.run(
			"simulators.close",
			{ chatId: refTarget.chatId, deviceId: device.id, shutdown },
			shutdown ? "shutdown" : "close",
		);
	};
	const screenshot = () => {
		setFlash((value) => value + 1);
		void simulatorCommand<string>(
			refTarget.environmentId,
			"simulators.screenshot",
			{ chatId: refTarget.chatId, deviceId: device.id },
		)
			.then((data) => {
				const anchor = document.createElement("a");
				anchor.href = `data:image/png;base64,${data}`;
				anchor.download = `${device.name} ${new Date().toISOString().slice(0, 19)}.png`;
				anchor.click();
			})
			.catch((error) => actions.setError(errorText(error)));
	};
	const toPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		return simulatorPoint(
			ref,
			Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
			Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
		);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-9 shrink-0 items-center gap-1 pl-1.5 pr-2">
				<SimulatorIconAction
					icon={ArrowLeft01Icon}
					label="All devices"
					onClick={() => {
						input.release();
						useUiStore.getState().showDevicePicker(panelRef, panelId);
					}}
				/>
				<div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
					<span className="truncate font-medium text-foreground">
						{device.name}
					</span>
					<span className="shrink-0 text-[11px] text-muted-foreground">
						{device.version}
					</span>
				</div>
				{android ? (
					<SimulatorIconAction
						icon={ArrowTurnBackwardIcon}
						label="Back"
						onClick={() => input.send({ _tag: "button", button: "back" })}
					/>
				) : null}
				<SimulatorIconAction
					icon={Home01Icon}
					label="Home"
					onClick={() => input.send({ _tag: "button", button: "home" })}
				/>
				<SimulatorIconAction
					icon={DashboardSquare01Icon}
					label={android ? "Recents" : "App switcher"}
					onClick={() => input.send({ _tag: "button", button: "app_switcher" })}
				/>
				{android ? null : (
					<SimulatorIconAction
						icon={ScreenRotationIcon}
						label="Rotate"
						onClick={() =>
							input.send({
								_tag: "rotate",
								orientation:
									screen.width > screen.height ? "portrait" : "landscape_left",
							})
						}
					/>
				)}
				<SimulatorIconAction
					icon={Camera01Icon}
					label="Save screenshot"
					onClick={screenshot}
				/>
				<Menu>
					<MenuTrigger
						className={cn(
							DOCK_ICON_BUTTON_CLASS,
							"data-[popup-open]:bg-muted/60",
						)}
						aria-label="More"
					>
						<HugeiconsIcon icon={MoreHorizontalIcon} className="size-3.5" />
					</MenuTrigger>
					<MenuPopup align="end" className="w-56">
						<MenuCheckboxItem
							checked={state.agentAccessEnabled}
							onCheckedChange={(checked) =>
								void actions.run(
									"simulators.configure",
									{ agentAccessEnabled: checked },
									"agents",
								)
							}
						>
							Let agents use devices
						</MenuCheckboxItem>
						<MenuItem onClick={openSimulatorSettings}>
							<HugeiconsIcon icon={Settings01Icon} />
							Simulator settings
						</MenuItem>
						<MenuSeparator />
						<MenuItem onClick={() => close(false)}>
							<HugeiconsIcon icon={Unlink01Icon} />
							Disconnect from chat
						</MenuItem>
						<MenuItem variant="destructive" onClick={() => close(true)}>
							<HugeiconsIcon icon={ShutDownIcon} />
							{android ? "Shut down emulator" : "Shut down simulator"}
						</MenuItem>
					</MenuPopup>
				</Menu>
			</header>
			{actions.error ? (
				<div className="px-4 pb-1">
					<SimulatorError>{actions.error}</SimulatorError>
				</div>
			) : null}
			<div
				ref={stage}
				className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-4 pt-2"
			>
				<div
					className="relative overflow-hidden bg-black shadow-[0_0_0_1px_var(--color-border),0_12px_32px_-12px_rgb(0_0_0/0.35)]"
					style={{
						width: fit.width,
						height: fit.height,
						// Proportional corners read as a device without drawing a bezel.
						borderRadius: Math.min(fit.width, fit.height) * 0.12,
					}}
				>
					<canvas
						ref={setCanvas}
						tabIndex={0}
						aria-label={`${device.name} screen. Click to touch; typing goes to the device.`}
						className={cn(
							"block size-full touch-none outline-none",
							video.size === null && "invisible",
						)}
						onFocus={() => setFocused(true)}
						onBlur={() => {
							setFocused(false);
							input.release();
						}}
						onPointerDown={(event) => {
							if (!event.isPrimary || input.pointer.current) return;
							event.currentTarget.focus();
							event.currentTarget.setPointerCapture(event.pointerId);
							input.touch("begin", toPoint(event));
						}}
						onPointerMove={(event) => {
							if (input.pointer.current) input.touch("move", toPoint(event));
						}}
						onPointerUp={(event) => {
							if (event.isPrimary && input.pointer.current)
								input.touch("end", toPoint(event));
						}}
						onPointerCancel={input.release}
						onLostPointerCapture={input.release}
						onKeyDown={(event) => {
							if (android) {
								const next = androidKeyInput(event);
								if (!next) return;
								event.preventDefault();
								input.send(next);
								return;
							}
							const usage = simulatorKeyUsage(event.code);
							if (usage === null || event.repeat) return;
							event.preventDefault();
							input.key("down", usage);
						}}
						onKeyUp={(event) => {
							if (android) return;
							const usage = simulatorKeyUsage(event.code);
							if (usage === null) return;
							event.preventDefault();
							input.key("up", usage);
						}}
					/>
					{video.size === null && !streamError ? (
						<div className="absolute inset-0 flex items-center justify-center bg-muted/40">
							<Spinner className="size-4 text-muted-foreground" />
						</div>
					) : null}
					{streamError ? (
						<div
							role="alert"
							className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center backdrop-blur-sm"
						>
							<p className="text-xs leading-5 text-muted-foreground">
								{streamError}
							</p>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setDecodeError(null);
									getRendererClientBus().restart(simulatorVideoKey(ref));
								}}
							>
								Reconnect
							</Button>
						</div>
					) : null}
					{flash > 0 ? (
						<div
							key={flash}
							aria-hidden
							ref={(node) => {
								node?.animate([{ opacity: 0.6 }, { opacity: 0 }], {
									duration: 240,
									easing: "ease-out",
									fill: "forwards",
								});
							}}
							className="pointer-events-none absolute inset-0 bg-white opacity-0"
						/>
					) : null}
					{focused ? (
						<div
							aria-hidden
							className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-inset ring-ring/70"
						/>
					) : null}
				</div>
			</div>
		</div>
	);
}

/** Largest box with `aspect` that fits inside the element's content box. */
function useFit(
	element: React.RefObject<HTMLDivElement | null>,
	aspect: number,
) {
	const [box, setBox] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const node = element.current;
		if (!node) return;
		const measure = () => {
			const style = getComputedStyle(node);
			setBox({
				width:
					node.clientWidth -
					Number.parseFloat(style.paddingLeft) -
					Number.parseFloat(style.paddingRight),
				height:
					node.clientHeight -
					Number.parseFloat(style.paddingTop) -
					Number.parseFloat(style.paddingBottom),
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [element]);
	const width = Math.max(0, Math.min(box.width, box.height * aspect));
	return { width, height: aspect > 0 ? width / aspect : 0 };
}

/**
 * Serializes input to the host. Consecutive moves coalesce, releases are never
 * dropped, and every pressed key or touch is released when focus leaves.
 */
function useSimulatorInput(
	ref: ChatRef & { deviceId: string },
	onError: (error: string | null) => void,
) {
	const pending = useRef<SimulatorInput[]>([]);
	const sending = useRef(false);
	const pressed = useRef(new Set<number>());
	const pointer = useRef(false);
	const lastPoint = useRef({ x: 0.5, y: 0.5 });
	const send = useCallback(
		(input: SimulatorInput) => {
			const last = pending.current.at(-1);
			if (
				input._tag === "touch" &&
				input.phase === "move" &&
				last?._tag === "touch" &&
				last.phase === "move"
			)
				pending.current[pending.current.length - 1] = input;
			else if (
				pending.current.length < MAX_PENDING_INPUT ||
				(input._tag === "key" && input.phase === "up") ||
				(input._tag === "touch" && input.phase === "end")
			)
				pending.current.push(input);
			else {
				onError("Input is backed up. Release the controls and try again.");
				return;
			}
			if (sending.current) return;
			sending.current = true;
			void (async () => {
				try {
					while (pending.current.length) {
						const next = pending.current.shift();
						if (next)
							await simulatorCommand(ref.environmentId, "simulators.input", {
								chatId: ref.chatId,
								deviceId: ref.deviceId,
								input: next,
							});
					}
				} catch (error) {
					pending.current = [];
					onError(errorText(error));
				} finally {
					sending.current = false;
				}
			})();
		},
		[ref.environmentId, ref.chatId, ref.deviceId, onError],
	);
	const release = useCallback(() => {
		for (const usage of pressed.current)
			send({ _tag: "key", phase: "up", usage });
		pressed.current.clear();
		if (pointer.current) {
			pointer.current = false;
			send({ _tag: "touch", phase: "end", ...lastPoint.current });
		}
	}, [send]);
	useEffect(() => release, [release]);
	const touch = (
		phase: "begin" | "move" | "end",
		point: { x: number; y: number },
	) => {
		pointer.current = phase !== "end";
		lastPoint.current = point;
		send({ _tag: "touch", phase, ...point });
	};
	const key = (phase: "down" | "up", usage: number) => {
		if (phase === "down") pressed.current.add(usage);
		else pressed.current.delete(usage);
		send({ _tag: "key", phase, usage });
	};
	return { send, release, touch, key, pointer };
}

/** Android takes text for printable keys, keycodes for the rest, and Escape as Back. */
function androidKeyInput(event: React.KeyboardEvent): SimulatorInput | null {
	if (event.metaKey || event.ctrlKey) return null;
	if (event.key === "Escape") return { _tag: "button", button: "back" };
	const keycode = androidKeycode(event.key);
	if (keycode !== null) return { _tag: "keycode", keycode };
	return event.key.length === 1 ? { _tag: "text", text: event.key } : null;
}
