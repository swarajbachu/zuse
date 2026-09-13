type Point = { readonly clientX: number; readonly clientY: number };

/** Keep sidebar drags in the renderer so the browser's native DnD cursor
 * cannot replace the grabbing cursor while moving between drop targets. */
export const startSidebarPointerDrag = (
	element: HTMLElement,
	start: PointerEvent,
	callbacks: {
		readonly onMove: (point: Point) => void;
		readonly onDrop: (point: Point) => void;
		readonly onEnd: () => void;
	},
): (() => void) => {
	const doc = element.ownerDocument;
	const view = doc.defaultView;
	if (view === null) return () => {};
	let dragging = false;
	let ended = false;
	let preview: HTMLElement | null = null;
	let clickTimer: number | undefined;
	let scrollFrame: number | undefined;
	let point: Point = start;
	const scrollArea = element.closest<HTMLElement>("[data-sidebar-scroll]");
	const scroll = () => {
		scrollFrame = undefined;
		if (ended || scrollArea === null) return;
		const rect = scrollArea.getBoundingClientRect();
		if (point.clientX < rect.left || point.clientX > rect.right) return;
		const velocity =
			point.clientY < rect.top + 28
				? -8
				: point.clientY > rect.bottom - 28
					? 8
					: 0;
		const previous = scrollArea.scrollTop;
		scrollArea.scrollTop += velocity;
		if (scrollArea.scrollTop === previous) return;
		callbacks.onMove(point);
		scrollFrame = view.requestAnimationFrame(scroll);
	};
	const preventClick = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};
	const removeClickGuard = () => {
		view.clearTimeout(clickTimer);
		doc.removeEventListener("click", preventClick, { capture: true });
		view.removeEventListener("pointerup", releaseClickGuard);
		view.removeEventListener("pointerdown", removeClickGuard, {
			capture: true,
		});
	};
	const releaseClickGuard = () => {
		clickTimer = view.setTimeout(removeClickGuard, 0);
	};
	const finish = () => {
		if (ended) return;
		ended = true;
		view.removeEventListener("pointermove", onMove);
		view.removeEventListener("pointerup", onUp);
		view.removeEventListener("pointercancel", onCancel);
		view.removeEventListener("keydown", onKeyDown, { capture: true });
		view.removeEventListener("blur", finish);
		element.removeEventListener("lostpointercapture", finish);
		if (scrollFrame !== undefined) view.cancelAnimationFrame(scrollFrame);
		if (element.hasPointerCapture(start.pointerId))
			element.releasePointerCapture(start.pointerId);
		if (dragging) {
			doc.documentElement.removeAttribute("data-sidebar-dragging");
			preview?.remove();
			// Keep the click guard through release, including after Escape/blur.
			view.addEventListener("pointerup", releaseClickGuard, { once: true });
			view.addEventListener("pointerdown", removeClickGuard, {
				once: true,
				capture: true,
			});
		}
		callbacks.onEnd();
	};
	const onMove = (event: PointerEvent) => {
		if (event.pointerId !== start.pointerId) return;
		if ((event.buttons & 1) === 0) {
			finish();
			return;
		}
		if (!dragging) {
			if (
				Math.hypot(
					event.clientX - start.clientX,
					event.clientY - start.clientY,
				) < 5
			)
				return;
			dragging = true;
			element.setPointerCapture(start.pointerId);
			element.addEventListener("lostpointercapture", finish);
			doc.documentElement.setAttribute("data-sidebar-dragging", "");
			doc.addEventListener("click", preventClick, true);
			const rect = element.getBoundingClientRect();
			preview = element.cloneNode(true) as HTMLElement;
			preview.removeAttribute("id");
			preview.setAttribute("aria-hidden", "true");
			preview.inert = true;
			Object.assign(preview.style, {
				position: "fixed",
				left: `${rect.left}px`,
				top: `${rect.top}px`,
				width: `${rect.width}px`,
				pointerEvents: "none",
				opacity: "0.75",
				zIndex: "9999",
			});
			doc.body.append(preview);
		}
		event.preventDefault();
		point = event;
		if (preview !== null)
			preview.style.transform = `translate(${event.clientX - start.clientX}px, ${event.clientY - start.clientY}px)`;
		callbacks.onMove(event);
		if (scrollFrame === undefined)
			scrollFrame = view.requestAnimationFrame(scroll);
	};
	const onUp = (event: PointerEvent) => {
		if (event.pointerId !== start.pointerId) return;
		try {
			if (dragging) callbacks.onDrop(event);
		} finally {
			finish();
			releaseClickGuard();
		}
	};
	const onCancel = (event: PointerEvent) => {
		if (event.pointerId === start.pointerId) finish();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		finish();
	};
	view.addEventListener("pointermove", onMove, { passive: false });
	view.addEventListener("pointerup", onUp);
	view.addEventListener("pointercancel", onCancel);
	view.addEventListener("keydown", onKeyDown, true);
	view.addEventListener("blur", finish);
	return () => {
		finish();
		removeClickGuard();
	};
};
