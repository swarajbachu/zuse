import { EnvironmentId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiSpecBlock } from "../../src/components/ui-spec-block.tsx";

const render = (spec: string) =>
	renderToStaticMarkup(<UiSpecBlock spec={spec} />);

const followUps =
	'root = FollowUps([{label: "Run tests", prompt: "Run the full test suite."}])';

describe("generated UI transcript blocks", () => {
	it("renders nested dashboard components and accessible progress", () => {
		const html = render(
			'root = Card([Grid([Stat("Tests", "428", "All passing"), Progress("Complete", 80)], 2), Table(["File", "Status"], [["app.ts", "passed"]]), Badge("Ready", "good")], "Build health")',
		);
		for (const text of [
			"Build health",
			"428",
			"All passing",
			"app.ts",
			"passed",
			"Ready",
		])
			expect(html).toContain(text);
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="80"');
		expect(html).not.toContain("could not");
	});
	it("renders zero and negative comparison values without invalid widths", () => {
		const html = render(
			'root = BarChart("Change", [{label: "Build", value: -3}, {label: "Tests", value: 2}, {label: "Lint", value: 0}], "s")',
		);
		for (const text of ["Build", "-3 s", "Tests", "2 s", "Lint", "0 s"])
			expect(html).toContain(text);
		expect(html).not.toMatch(/NaN|Infinity|width:-/);
	});
	it("keeps line chart values available to assistive technology", () => {
		const html = render(
			'root = LineChart("Latency", [{label: "Mon", value: 12}, {label: "Tue", value: 9}], "ms")',
		);
		for (const text of ["Latency", "Mon", "12 ms", "Tue", "9 ms"])
			expect(html).toContain(text);
	});
	it("shows the source when a persisted block cannot render", () => {
		const html = render('root = Missing("legacy")');
		expect(html).toContain("legacy");
		expect(html).toContain("<pre");
		expect(html).toContain("Unknown component");
	});
	it("never interprets model text as markup", () => {
		const html = render('root = Text("<img src=x onerror=alert(1)>")');
		expect(html).toContain("&lt;img");
		expect(html).not.toContain("<img");
	});
	it("renders follow-ups as buttons that are enabled only for a live session", () => {
		const readOnly = render(followUps);
		expect(readOnly).toContain("Run tests");
		expect(readOnly).toContain('title="Run the full test suite."');
		expect(readOnly).toMatch(/<button[^>]* disabled=""/);

		const live = renderToStaticMarkup(
			<UiSpecBlock
				spec={followUps}
				sessionRef={{
					environmentId: EnvironmentId.make("local"),
					sessionId: SessionId.make("session"),
				}}
			/>,
		);
		expect(live).toContain("Run tests");
		expect(live).not.toMatch(/<button[^>]* disabled=""/);
	});
	it("renders form fields with their defaults, disabled outside the latest turn", () => {
		const spec = `root = Form([env, region, migrate, rollout, notes], "Deploy", "Deploy settings")
env = RadioGroup("env", "Environment", ["staging", "production"], "staging")
region = Select("region", "Region", ["us-east-1", "eu-west-1"], "eu-west-1")
migrate = Checkbox("migrate", "Run migrations", true)
rollout = Slider("rollout", "Rollout", 0, 100, 25, 5)
notes = TextArea("notes", "Notes", "Optional")`;
		const readOnly = render(spec);
		for (const text of [
			"Deploy settings",
			"Environment",
			"production",
			"Region",
			"eu-west-1",
			"Run migrations",
			"Rollout",
			"25",
			"Notes",
			"Deploy",
		])
			expect(readOnly).toContain(text);
		expect(readOnly).toMatch(
			/role="radio" aria-checked="true"[^>]*>(?:<svg[\s\S]*?<\/svg>)?staging/,
		);
		expect(readOnly).toMatch(/<button type="submit"[^>]* disabled=""/);

		const live = renderToStaticMarkup(
			<UiSpecBlock
				spec={spec}
				sessionRef={{
					environmentId: EnvironmentId.make("local"),
					sessionId: SessionId.make("session"),
				}}
			/>,
		);
		expect(live).not.toMatch(/<button type="submit"[^>]* disabled=""/);
	});
	it("renders steps, callouts, and only the active tab", () => {
		const html = render(`root = Card([plan, risk, views])
plan = Steps([{label: "Build", status: "done"}, {label: "Test", status: "active", detail: "3 of 5"}, {label: "Ship", status: "pending"}])
risk = Callout("Migrations lock the users table.", "warn", "Heads up")
views = Tabs([{label: "Before", content: Text("Old flow")}, {label: "After", content: Text("New flow")}])`);
		for (const text of [
			"Build",
			"3 of 5",
			"Ship",
			"Heads up",
			"Before",
			"After",
			"Old flow",
		])
			expect(html).toContain(text);
		expect(html).toContain('data-status="active"');
		expect(html).not.toContain("New flow");
	});
});
