"use client";

import {
	Component,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";

const Dither = lazy(() => import("./react-bits/Dither.jsx"));

class DitherBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/** React Bits Dither, unchanged. Only its lifecycle is managed here: load the
 * WebGL bundle when visible and release it when offscreen or the tab is hidden. */
export function ReactBitsDither({ className = "" }: { className?: string }) {
	const root = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [reducedMotion, setReducedMotion] = useState(false);
	const [dark, setDark] = useState(true);
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		let inViewport = false;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const themeRoot =
			element.closest("[data-theme]") ?? document.documentElement;
		const updateVisibility = () => setVisible(inViewport && !document.hidden);
		const updateMotion = () => setReducedMotion(motion.matches);
		const updateTheme = () =>
			setDark(
				themeRoot.getAttribute("data-theme") === "dark" ||
					(themeRoot.getAttribute("data-theme") !== "light" &&
						document.documentElement.classList.contains("dark")),
			);
		const viewport = new IntersectionObserver(([entry]) => {
			inViewport = entry?.isIntersecting ?? false;
			updateVisibility();
		});
		const theme = new MutationObserver(updateTheme);
		viewport.observe(element);
		theme.observe(themeRoot, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
		motion.addEventListener("change", updateMotion);
		document.addEventListener("visibilitychange", updateVisibility);
		updateMotion();
		updateTheme();
		return () => {
			viewport.disconnect();
			theme.disconnect();
			motion.removeEventListener("change", updateMotion);
			document.removeEventListener("visibilitychange", updateVisibility);
		};
	}, []);
	return (
		<div
			ref={root}
			aria-hidden="true"
			className={className}
			style={{ pointerEvents: "none", overflow: "hidden" }}
		>
			{visible && (
				<DitherBoundary>
					<Suspense fallback={null}>
						<Dither
							waveColor={dark ? [0.42, 0.52, 0.26] : [0.45, 0.55, 0.3]}
							backgroundColor={dark ? [0.025, 0.03, 0.025] : [0.98, 0.98, 0.97]}
							disableAnimation={reducedMotion}
							enableMouseInteraction={false}
						/>
					</Suspense>
				</DitherBoundary>
			)}
		</div>
	);
}
