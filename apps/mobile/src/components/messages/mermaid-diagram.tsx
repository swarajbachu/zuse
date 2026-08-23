"use dom";

import type { DOMProps } from "expo/dom";
import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";

type MermaidDiagramProps = {
	source: string;
	dark: boolean;
	dom?: DOMProps;
};

const disableNetworkAccess = (): void => {
	globalThis.fetch = () =>
		Promise.reject(new Error("Network access is disabled for diagrams"));

	if (typeof XMLHttpRequest !== "undefined") {
		XMLHttpRequest.prototype.open = () => {
			throw new Error("Network access is disabled for diagrams");
		};
	}
};

export default function MermaidDiagram({ source, dark }: MermaidDiagramProps) {
	const id = useId().replaceAll(":", "");
	const [svg, setSvg] = useState<string>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		let cancelled = false;
		disableNetworkAccess();
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			htmlLabels: false,
			theme: dark ? "dark" : "default",
		});
		void mermaid
			.render(`diagram-${id}`, source)
			.then((result) => {
				if (!cancelled) {
					setError(undefined);
					setSvg(result.svg);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSvg(undefined);
					setError("This diagram could not be rendered.");
				}
			});

		return () => {
			cancelled = true;
		};
	}, [dark, id, source]);

	return (
		<main data-theme={dark ? "dark" : "light"}>
			{error ? (
				<p role="alert">{error}</p>
			) : svg ? (
				<div
					role="img"
					aria-label="Mermaid diagram"
					// Mermaid's strict security mode sanitizes the generated SVG.
					// biome-ignore lint/security/noDangerouslySetInnerHtml: strict mode returns sanitized, locally generated SVG.
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
			) : (
				<p aria-live="polite">Rendering diagram…</p>
			)}
			<style>{`
				:root {
					color-scheme: ${dark ? "dark" : "light"};
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				}
				html, body, #root {
					margin: 0;
					min-height: 100%;
					overflow: auto;
					background: transparent;
				}
				main {
					box-sizing: border-box;
					display: grid;
					min-height: 100%;
					place-items: center;
					padding: 12px;
				}
				main[data-theme="dark"] { color: #f5f5f5; }
				main[data-theme="light"] { color: #18181b; }
				div { max-width: 100%; }
				svg {
					display: block;
					height: auto;
					max-width: 100%;
				}
				p {
					margin: 0;
					color: inherit;
					font-size: 13px;
					opacity: 0.72;
				}
			`}</style>
		</main>
	);
}
