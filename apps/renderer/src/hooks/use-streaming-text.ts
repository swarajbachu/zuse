import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { StreamingTextReveal } from "../lib/streaming-text-reveal.ts";

export function useStreamingText(text: string, enabled: boolean): string {
	const reduce = useReducedMotion();
	const reveal = useRef<StreamingTextReveal | null>(null);
	if (reveal.current === null) reveal.current = new StreamingTextReveal(text);
	const [visible, setVisible] = useState(text);
	useEffect(() => {
		const buffer = reveal.current;
		if (buffer === null) return;
		buffer.update(
			text,
			performance.now(),
			enabled && !reduce && !document.hidden,
		);
		setVisible(buffer.text);
		let frame: number | undefined;
		const tick = (now: number) => {
			if (document.hidden) buffer.update(text, now, false);
			setVisible(buffer.frame(now));
			if (buffer.pending) frame = requestAnimationFrame(tick);
		};
		if (buffer.pending) frame = requestAnimationFrame(tick);
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [text, enabled, reduce]);
	// Completion and reduced motion flush without waiting for an effect/frame.
	return !enabled || reduce ? text : visible;
}
