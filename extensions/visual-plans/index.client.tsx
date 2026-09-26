import type {
	ExtensionClientContext,
	ExtensionClientHost,
	ExtensionWorkspacePanelProps,
} from "@zuse/extension-sdk";
import { useMemo, useState } from "react";
import { defaultInstructions, extractHtml, previewDocument } from "./plan.ts";
import "./style.css";
export function Panel(
	props: ExtensionWorkspacePanelProps & { host: ExtensionClientHost },
) {
	const output = props.host.usePlanOutput(props.sessionId);
	const [instructions, setInstructions] = useState(defaultInstructions);
	const [feedback, setFeedback] = useState("");
	const [pasted, setPasted] = useState("");
	const [preview, setPreview] = useState("");
	const [previewSource, setPreviewSource] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const html = useMemo(() => {
		try {
			return extractHtml(pasted || output.text);
		} catch {
			return null;
		}
	}, [pasted, output.text]);
	const prepare = async () => {
		if (!props.sessionId) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await props.host.preparePlan(props.sessionId, instructions);
			setNotice(
				"Plan mode is on. Instructions are attached to the composer. Add your task and submit when ready.",
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not prepare the plan.");
		} finally {
			setBusy(false);
		}
	};
	const attachFeedback = async () => {
		if (!feedback.trim() || !previewSource) return;
		setBusy(true);
		setError("");
		try {
			await props.attach({
				id: crypto.randomUUID(),
				title: "Visual plan revision",
				text: `Revise this plan, staying in Plan mode. Do not implement it.\n\nFeedback:\n${feedback}\n\nPlan snapshot:\n${previewSource}`,
			});
			setNotice(
				"Revision feedback and the plan snapshot are attached. Submit through the composer.",
			);
			setFeedback("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not attach feedback.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="zv-panel">
			<header>
				<h1>Visual Plans</h1>
				<p>Understand the proposed change before the agent implements it.</p>
			</header>
			<details>
				<summary>Customize plan instructions</summary>
				<textarea
					aria-label="Plan instructions"
					value={instructions}
					maxLength={16000}
					onChange={(e) => setInstructions(e.target.value)}
				/>
			</details>
			<div className="zv-actions">
				<button
					className="h-7"
					type="button"
					disabled={busy || !props.sessionId}
					onClick={() => void prepare()}
				>
					Prepare visual plan
				</button>
				<button
					className="h-7"
					type="button"
					disabled={!html || (output.truncated && !pasted)}
					onClick={() => {
						try {
							setError("");
							setPreview(previewDocument(html ?? ""));
							setPreviewSource(html ?? "");
						} catch (e) {
							setError(
								e instanceof Error ? e.message : "Could not preview plan.",
							);
						}
					}}
				>
					Preview latest HTML
				</button>
			</div>
			{!props.sessionId && <p>Open a local conversation to prepare a plan.</p>}
			{notice && <p role="status">{notice}</p>}
			{error && <p role="alert">{error}</p>}
			{output.stale && props.sessionId && (
				<p>Conversation is not live. Available output may be cached.</p>
			)}
			{output.truncated && !pasted && (
				<p role="alert">
					Agent output exceeds 128 KiB. Ask for a shorter plan.
				</p>
			)}
			{!html && (
				<p>
					The latest agent response has no complete HTML plan yet. Submit the
					plan instructions, or paste an HTML plan below.
				</p>
			)}
			<details>
				<summary>Paste HTML or a fenced HTML plan</summary>
				<textarea
					aria-label="HTML plan"
					value={pasted}
					maxLength={131072}
					onChange={(e) => setPasted(e.target.value)}
					placeholder="Paste a complete HTML document or fenced html block…"
				/>
			</details>
			{preview && (
				<iframe
					title="Visual plan preview"
					sandbox=""
					referrerPolicy="no-referrer"
					srcDoc={preview}
				/>
			)}
			<label>
				What should change?
				<textarea
					aria-label="Plan revision feedback"
					placeholder="Explain this part more clearly, compare alternatives, add a sequence diagram…"
					value={feedback}
					maxLength={8000}
					onChange={(e) => setFeedback(e.target.value)}
				/>
			</label>
			<button
				className="h-7"
				type="button"
				disabled={
					busy || !previewSource || !feedback.trim() || !props.sessionId
				}
				onClick={() => void attachFeedback()}
			>
				Attach revision feedback
			</button>
			<footer>
				Previewing does not approve the plan. Submit and approve work through
				Zuse’s normal conversation controls. Scripts and external resources are
				blocked in previews.
			</footer>
		</section>
	);
}
export default function setup(e: ExtensionClientContext) {
	e.addWorkspacePanel({
		id: "plans",
		title: "Visual Plans",
		icon: "package",
		Component: (props) => (
			<Panel
				key={`${props.workspacePath}:${props.sessionId}`}
				{...props}
				host={e.host}
			/>
		),
	});
	return () => {};
}
