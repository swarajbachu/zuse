"use client";

import { renderDitherImage } from "@repo/ui/dither-image";
import { canvasToBlob, IMAGE_ACCEPT, readImageFile } from "@repo/ui/image-file";
import {
	ArrowLeft,
	Check,
	ChevronDown,
	Download,
	Expand,
	ImagePlus,
	RotateCcw,
	ShieldCheck,
	SlidersHorizontal,
	Upload,
	X,
} from "lucide-react";
import Link from "next/link";
import {
	type ButtonHTMLAttributes,
	type CSSProperties,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { LogoMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

import {
	ALGORITHMS,
	DEFAULT_OPTIONS,
	type DitherOptions,
	PALETTES,
} from "@/lib/dither";

function Button({
	className = "",
	variant = "quiet",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "quiet" | "primary";
}) {
	return (
		<button
			type="button"
			className={`studio-button studio-button--${variant} ${className}`}
			{...props}
		/>
	);
}

function SliderRow({
	label,
	value,
	min,
	max,
	unit,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	unit: string;
	onChange: (value: number) => void;
}) {
	const id = useId();
	return (
		<div
			className="studio-slider"
			style={
				{
					"--progress": `${((value - min) / (max - min)) * 100}%`,
				} as CSSProperties
			}
		>
			<label htmlFor={id}>{label}</label>
			<span className="studio-slider-value" aria-hidden="true">
				{value}
				{unit}
			</span>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				value={value}
				aria-valuetext={`${value}${unit}`}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
		</div>
	);
}

export function DitherEditor() {
	const [controlsOpen, setControlsOpen] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [zoom, setZoom] = useState("fit");
	const [source, setSource] = useState<HTMLCanvasElement | null>(null);
	const [name, setName] = useState("image");
	const [options, setOptions] = useState(DEFAULT_OPTIONS);
	const [error, setError] = useState<{
		message: string;
		kind: "upload" | "render" | "export";
	} | null>(null);
	// Render validity survives dismissing unrelated upload/export errors.
	const [renderFailed, setRenderFailed] = useState(false);
	const [loading, setLoading] = useState(false);
	const [rendering, setRendering] = useState(false);
	const [original, setOriginal] = useState(false);
	const [exporting, setExporting] = useState(false);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const originalRef = useRef<HTMLCanvasElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const uploadId = useRef(0);

	useEffect(() => {
		if (!controlsOpen) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setControlsOpen(false);
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [controlsOpen]);

	async function upload(file: File) {
		const id = ++uploadId.current;
		setLoading(true);
		setError(null);
		try {
			const image = await readImageFile(file);
			if (id !== uploadId.current) return;
			setSource(image);
			setZoom("fit");
			setControlsOpen(false);
			setRendering(true);
			setName(file.name.replace(/\.[^.]+$/, ""));
		} catch (cause) {
			if (id === uploadId.current)
				setError({
					kind: "upload",
					message:
						cause instanceof Error
							? cause.message
							: "Could not open this image.",
				});
		} finally {
			if (id === uploadId.current) setLoading(false);
		}
	}

	useEffect(() => {
		if (!source) return;
		const originalCanvas = originalRef.current;
		if (originalCanvas) {
			originalCanvas.width = source.width;
			originalCanvas.height = source.height;
			originalCanvas.getContext("2d")?.drawImage(source, 0, 0);
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			void renderDitherImage(source, options, controller.signal)
				.then((result) => {
					if (controller.signal.aborted) return;
					const canvas = canvasRef.current;
					if (canvas) {
						canvas.width = result.width;
						canvas.height = result.height;
						canvas.getContext("2d")?.drawImage(result, 0, 0);
					}
					setRenderFailed(false);
					setRendering(false);
				})
				.catch((cause) => {
					if (controller.signal.aborted) return;
					setRenderFailed(true);
					setError({
						kind: "render",
						message:
							cause instanceof Error
								? cause.message
								: "Could not process image.",
					});
					setRendering(false);
				});
		}, 80);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [source, options]);

	function update<K extends keyof DitherOptions>(
		key: K,
		value: DitherOptions[K],
	) {
		setRendering(!!source);
		setError(null);
		setOptions((current) => ({ ...current, [key]: value }));
	}

	async function download() {
		if (
			!canvasRef.current ||
			!source ||
			rendering ||
			loading ||
			renderFailed ||
			error
		)
			return;
		setExporting(true);
		try {
			const blob = await canvasToBlob(canvasRef.current);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${name}-dither.png`;
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (cause) {
			setError({
				kind: "export",
				message:
					cause instanceof Error
						? cause.message
						: "Export failed. Please try again.",
			});
		} finally {
			setExporting(false);
		}
	}

	function reset() {
		setOptions({ ...DEFAULT_OPTIONS });
		setRendering(!!source);
		setError(null);
	}
	const busy = loading || rendering;
	const canvasStyle =
		source && zoom !== "fit"
			? {
					width: source.width * Number(zoom),
					height: source.height * Number(zoom),
					maxWidth: "none",
					maxHeight: "none",
				}
			: undefined;
	const stateLabel = loading
		? "Opening image…"
		: rendering
			? "Rendering…"
			: renderFailed
				? "Render failed. Reset adjustments to retry."
				: source
					? "Ready"
					: "No image loaded";
	return (
		<main className="dither-studio" data-controls-open={controlsOpen}>
			<aside
				id="studio-controls"
				aria-label="Image controls"
				className="studio-sidebar"
			>
				<div className="studio-brand">
					<Link href="/" aria-label="Zuse home">
						<LogoMark className="size-6" />
						<span>Zuse</span>
					</Link>
					<span className="studio-brand-divider" />
					<h1>Dither studio</h1>
					<Button
						className="studio-icon-button studio-close-controls"
						aria-label="Close controls"
						onClick={() => setControlsOpen(false)}
					>
						<X size={15} />
					</Button>
				</div>
				<div className="studio-controls-scroll">
					<div className="studio-source">
						<Button
							className="studio-upload"
							onClick={() => fileRef.current?.click()}
							disabled={loading}
						>
							<ImagePlus size={15} />
							{source ? "Replace image" : "Upload image"}
							<span>↑</span>
						</Button>
						<p>
							{source
								? `${source.width} × ${source.height} px`
								: "PNG, JPG, WebP, AVIF, GIF · Max 20 MB"}
						</p>
					</div>
					<details className="studio-section" open>
						<summary>
							<ChevronDown size={12} />
							<span>Algorithm</span>
							<span className="studio-section-caption">08</span>
						</summary>
						<div className="studio-section-body studio-algorithms">
							{Object.entries(ALGORITHMS).map(([value, label]) => (
								<button
									type="button"
									key={value}
									aria-pressed={options.algorithm === value}
									onClick={() =>
										update("algorithm", value as DitherOptions["algorithm"])
									}
								>
									{label}
								</button>
							))}
						</div>
					</details>
					<details className="studio-section" open>
						<summary>
							<ChevronDown size={12} />
							<span>Palette</span>
							<span className="studio-section-caption">
								{PALETTES[options.palette].label.split(" · ")[0]}
							</span>
						</summary>
						<div className="studio-section-body studio-palettes">
							{Object.entries(PALETTES).map(([value, palette]) => (
								<button
									type="button"
									key={value}
									aria-label={palette.label}
									aria-pressed={options.palette === value}
									onClick={() =>
										update("palette", value as DitherOptions["palette"])
									}
								>
									<span className="studio-palette-colors" aria-hidden="true">
										{palette.colors.length ? (
											palette.colors.map((color) => (
												<span
													key={color.join()}
													style={{ background: `rgb(${color.join(",")})` }}
												/>
											))
										) : (
											<span className="studio-spectrum" />
										)}
									</span>
									<span>{palette.label.split(" · ")[0]}</span>
									{options.palette === value && <Check size={11} />}
								</button>
							))}
						</div>
					</details>
					<details className="studio-section" open>
						<summary>
							<ChevronDown size={12} />
							<span>Texture & tone</span>
						</summary>
						<div className="studio-section-body studio-adjustments">
							{(
								[
									["pixelSize", "Pixel size", 1, 8, "px"],
									["strength", "Strength", 0, 100, "%"],
									["contrast", "Contrast", 0, 200, "%"],
									["brightness", "Brightness", -50, 50, ""],
									["blur", "Softness", 0, 12, "px"],
								] as const
							).map(([key, label, min, max, unit]) => (
								<SliderRow
									key={key}
									label={label}
									value={options[key]}
									min={min}
									max={max}
									unit={unit}
									onChange={(value) => update(key, value)}
								/>
							))}
						</div>
					</details>
					<Button className="studio-reset" onClick={reset}>
						<RotateCcw size={12} />
						Reset adjustments
					</Button>
				</div>
				<div className="studio-export">
					<Button
						variant="primary"
						onClick={() => void download()}
						disabled={!source || busy || exporting || renderFailed || !!error}
					>
						<Download size={14} />
						{exporting ? "Exporting…" : "Export PNG"}
						<span>↗</span>
					</Button>
					<p>Set it as your wallpaper in Zuse → Appearance.</p>
				</div>
			</aside>
			{controlsOpen && (
				<button
					type="button"
					className="studio-scrim"
					aria-label="Close image controls"
					onClick={() => setControlsOpen(false)}
				/>
			)}
			<div className="studio-workspace">
				<header className="studio-toolbar">
					<Button
						className="studio-icon-button studio-open-controls"
						aria-label="Image controls"
						aria-expanded={controlsOpen}
						aria-controls="studio-controls"
						onClick={() => setControlsOpen(!controlsOpen)}
					>
						<SlidersHorizontal size={16} />
					</Button>
					<fieldset className="studio-view-switch" aria-label="Preview mode">
						<button
							type="button"
							aria-pressed={!original}
							onClick={() => setOriginal(false)}
						>
							Dither
						</button>
						<button
							type="button"
							aria-pressed={original}
							disabled={!source}
							onClick={() => setOriginal(true)}
						>
							Original
						</button>
					</fieldset>
					<div className="studio-toolbar-actions">
						<ThemeToggle className="studio-button studio-button--quiet studio-icon-button" />
						<Link
							className="studio-back-link"
							href="/"
							aria-label="Back to Zuse"
						>
							<ArrowLeft size={13} />
							<span>Back to Zuse</span>
						</Link>
					</div>
				</header>
				<section
					aria-label="Image preview"
					className="studio-preview"
					data-dragging={dragging}
					onDragOver={(event) => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={(event) => {
						if (
							!event.currentTarget.contains(event.relatedTarget as Node | null)
						)
							setDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						const file = event.dataTransfer.files[0];
						if (file) void upload(file);
					}}
				>
					<div className="studio-canvas-scroll">
						<div className="studio-canvas-stage" data-fit={zoom === "fit"}>
							{!source && (
								<div className="studio-empty">
									<div className="studio-empty-icon">
										<Upload size={25} strokeWidth={1.4} />
									</div>
									<h2>Drop an image</h2>
									<p>A little texture, a different perspective.</p>
									<Button
										variant="primary"
										disabled={loading}
										onClick={() => fileRef.current?.click()}
									>
										<Upload size={14} />
										{loading ? "Opening image…" : "Browse files"}
									</Button>
									<span>PNG, JPG, WebP, AVIF or GIF</span>
								</div>
							)}
							<canvas
								ref={canvasRef}
								aria-label="Dithered image"
								hidden={!source || original}
								style={canvasStyle}
							/>
							<canvas
								ref={originalRef}
								aria-label="Original image"
								hidden={!source || !original}
								style={canvasStyle}
							/>
						</div>
					</div>
					{dragging && (
						<div className="studio-drop-overlay">
							<Upload size={20} />
							<span>Drop to {source ? "replace" : "open"} image</span>
						</div>
					)}
					{source && (
						<div className="studio-zoom">
							<Button
								className="studio-icon-button"
								aria-label="Fit image to canvas"
								onClick={() => setZoom("fit")}
							>
								<Expand size={14} />
							</Button>
							<label>
								<span className="sr-only">Canvas zoom</span>
								<select
									value={zoom}
									onChange={(event) => setZoom(event.target.value)}
								>
									<option value="fit">Fit</option>
									<option value="0.5">50%</option>
									<option value="1">100%</option>
									<option value="2">200%</option>
								</select>
							</label>
						</div>
					)}
					{error && (
						<div role="alert" className="studio-error">
							<span>{error.message}</span>
							<Button
								className="studio-icon-button"
								aria-label={
									error.kind === "render"
										? "Reset adjustments and dismiss error"
										: "Dismiss error"
								}
								onClick={() => {
									if (error.kind === "render") reset();
									else setError(null);
								}}
							>
								<X size={14} />
							</Button>
						</div>
					)}
				</section>
				<footer className="studio-statusbar">
					<span className="studio-filename">
						{source ? name : "Your next wallpaper starts here"}
						{source && (
							<span>
								{" "}
								· {source.width} × {source.height}
							</span>
						)}
					</span>
					<span role="status" className="studio-render-status" data-busy={busy}>
						<i />
						{stateLabel}
					</span>
					<span className="studio-private">
						<ShieldCheck size={12} />
						Processed on your device
					</span>
				</footer>
			</div>
			<input
				ref={fileRef}
				type="file"
				accept={IMAGE_ACCEPT}
				aria-label="Upload image"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) void upload(file);
				}}
			/>
		</main>
	);
}
