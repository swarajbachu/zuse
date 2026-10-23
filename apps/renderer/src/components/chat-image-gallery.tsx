import "@zuse/i18n/english/chat";
import type { Message } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type ChatImage, collectChatImages } from "~/lib/chat-images";
import { useChatImageSource, useChatImageTarget } from "./chat-image-source";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";

const GalleryContext = createContext<((image: ChatImage) => void) | null>(null);
export const useChatImageGallery = () => useContext(GalleryContext);

export function ChatImageGalleryProvider({
	messages,
	children,
}: {
	messages: readonly Message[];
	children: ReactNode;
}) {
	const images = useMemo(() => collectChatImages(messages), [messages]);
	const [selected, setSelected] = useState<ChatImage | null>(null);
	const open = useCallback((image: ChatImage) => setSelected(image), []);
	const gallery =
		selected && !images.some((image) => image.src === selected.src)
			? [...images, selected]
			: images;
	const index = selected
		? gallery.findIndex((image) => image.src === selected.src)
		: -1;
	return (
		<GalleryContext.Provider value={open}>
			{children}
			<Dialog
				open={selected !== null}
				onOpenChange={(value) => {
					if (!value) setSelected(null);
				}}
			>
				{selected && (
					<GalleryViewer
						images={gallery}
						index={index}
						onSelect={setSelected}
					/>
				)}
			</Dialog>
		</GalleryContext.Provider>
	);
}

function GalleryPicture({
	image,
	thumbnail = false,
	zoomed = false,
}: {
	image: ChatImage;
	thumbnail?: boolean;
	zoomed?: boolean;
}) {
	const { message } = useMessages(["chat"]);
	const target = useChatImageTarget(image.src);
	const { url, failed } = useChatImageSource(image.src, target);
	const [broken, setBroken] = useState(false);
	if (failed || broken)
		return (
			<span className="p-4 text-sm text-muted-foreground">
				{message("chat:image_gallery_unavailable")}
			</span>
		);
	return url ? (
		<img
			src={url}
			alt={image.alt}
			draggable={false}
			onError={() => setBroken(true)}
			className={
				thumbnail || zoomed
					? "size-full object-contain"
					: "block max-h-full max-w-full object-contain"
			}
		/>
	) : (
		<span className="p-4 text-sm text-muted-foreground" role="status">
			{message("chat:image_gallery_loading")}
		</span>
	);
}

function GalleryThumbnail({ image }: { image: ChatImage }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setVisible(true);
				observer.disconnect();
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		<span ref={ref} className="block size-full">
			{visible ? <GalleryPicture image={image} thumbnail /> : null}
		</span>
	);
}

function GalleryViewer({
	images,
	index,
	onSelect,
}: {
	images: readonly ChatImage[];
	index: number;
	onSelect: (image: ChatImage) => void;
}) {
	const { message } = useMessages(["chat"]);
	const [zoomed, setZoomed] = useState(false);
	const strip = useRef<HTMLDivElement>(null);
	const image = images[index];
	const select = (next: number) => {
		const item = images[next];
		if (item) {
			setZoomed(false);
			onSelect(item);
		}
	};
	useEffect(() => {
		strip.current
			?.querySelector('[aria-current="true"]')
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [index]);
	if (!image) return null;
	const control =
		"grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-white outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-25";
	return (
		<DialogPopup
			bottomStickOnMobile={false}
			className="h-[90dvh] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-none border-0 bg-black/95 text-white shadow-none sm:max-w-none"
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					select(index - 1);
				}
				if (event.key === "ArrowRight") {
					event.preventDefault();
					select(index + 1);
				}
			}}
		>
			<div className="flex h-14 shrink-0 items-center gap-3 px-4 pr-14">
				<DialogTitle className="truncate text-sm">
					{image.alt || message("chat:image_gallery_title")}
				</DialogTitle>
				<span
					className="ml-auto shrink-0 text-xs tabular-nums text-white/60"
					aria-live="polite"
				>
					{index + 1} / {images.length}
				</span>
				<button
					type="button"
					className={control}
					aria-label={
						zoomed
							? message("chat:image_gallery_fit")
							: message("chat:image_gallery_zoom")
					}
					onClick={() => setZoomed((value) => !value)}
				>
					{zoomed ? <ZoomOut size={18} /> : <ZoomIn size={18} />}
				</button>
			</div>
			<div className="relative flex min-h-0 flex-1 items-center gap-2 px-3">
				<button
					type="button"
					className={control}
					disabled={index === 0}
					aria-label={message("chat:image_gallery_previous")}
					onClick={() => select(index - 1)}
				>
					<ChevronLeft size={20} />
				</button>
				<div className="h-full min-w-0 flex-1 overflow-auto overscroll-contain">
					<button
						type="button"
						aria-label={
							zoomed
								? message("chat:image_gallery_fit")
								: message("chat:image_gallery_zoom")
						}
						onClick={() => setZoomed((value) => !value)}
						className={
							zoomed
								? "flex h-[200%] w-[200%] cursor-zoom-out items-center justify-center"
								: "flex h-full w-full cursor-zoom-in items-center justify-center"
						}
					>
						<GalleryPicture key={image.src} image={image} zoomed={zoomed} />
					</button>
				</div>
				<button
					type="button"
					className={control}
					disabled={index === images.length - 1}
					aria-label={message("chat:image_gallery_next")}
					onClick={() => select(index + 1)}
				>
					<ChevronRight size={20} />
				</button>
			</div>
			<div
				ref={strip}
				className="flex shrink-0 gap-2 overflow-x-auto overscroll-contain p-4"
			>
				{images.map((item, i) => (
					<button
						key={item.src}
						type="button"
						aria-label={message("chat:image_gallery_thumbnail", {
							index: i + 1,
							name: item.alt,
						})}
						aria-current={i === index ? "true" : undefined}
						onClick={() => select(i)}
						className={`h-16 w-20 shrink-0 overflow-hidden rounded-md bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-white ${i === index ? "ring-2 ring-white" : "opacity-55 hover:opacity-100"}`}
					>
						<GalleryThumbnail image={item} />
					</button>
				))}
			</div>
		</DialogPopup>
	);
}
