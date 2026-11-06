import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { ToolRow } from "../../src/components/tool-row.tsx";

const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(
	createElement(
		Fragment,
		null,
		createElement(ToolRow, {
			tool: "Bash",
			input: { command: "build" },
			result: { output: "preview", isError: false },
			deferredDetails: {
				key: "result-version-1",
				load: async (signal) => {
					const response = await fetch("/detail", { signal });
					if (!response.ok) throw new Error("Detail request failed");
					return response.json();
				},
			},
		}),
		createElement(
			"div",
			{ "data-testid": "grep" },
			createElement(ToolRow, {
				tool: "Grep",
				input: { pattern: "marker" },
				result: { output: "file1.ts:1:a\nfile2.ts:2:b", isError: false },
				deferredDetails: {
					key: "grep-preview",
					load: async () => {
						throw new Error("Unexpected detail fetch");
					},
				},
			}),
		),
	),
);
