import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { withWorkspaceConnection } from "../../src/components/workspace-connection-screen";

const state = vi.hoisted(() => ({
	values: new Map<string, unknown>(),
	params: { conn: "manual:laptop", sessionId: "session-a" },
	epoch: 1,
}));
vi.mock("@effect/atom-react", () => ({
	useAtomValue: (key: string) => state.values.get(key),
}));
vi.mock("expo-router", () => ({
	useLocalSearchParams: () => state.params,
	router: { replace: vi.fn() },
	Stack: { Screen: () => null },
}));
vi.mock("react-native", () => ({
	View: "div",
	Text: "span",
	ActivityIndicator: () => createElement("span", null, "Loading"),
}));
vi.mock("~/components/ui/button", () => ({
	Button: () => createElement("button", { type: "button" }, "Back"),
}));
vi.mock("~/store/auth", () => ({
	authAccountAtom: "account",
	authHydratedAtom: "authReady",
	hydrateAuth: vi.fn(),
}));
vi.mock("~/store/cloud-catalog", () => ({
	cloudCatalogAtom: "catalog",
	cloudCatalogGeneration: () => state.epoch,
}));
vi.mock("~/store/connections", () => ({
	allConnectionsAtom: "connections",
	connectionsHydratedAtom: "hydrated",
	hydrateConnections: vi.fn(),
}));

const secretScreen = vi.fn(() =>
	createElement("span", null, "Cached transcript and file"),
);
const Screen = withWorkspaceConnection(secretScreen);
const render = () => renderToStaticMarkup(createElement(Screen));

describe("workspace connection screen boundary", () => {
	beforeEach(() => {
		secretScreen.mockClear();
		state.values.clear();
		state.values.set("account", { id: "account-a" });
		state.values.set("catalog", { accountId: "account-a", loading: false });
		state.values.set("authReady", true);
		state.values.set("hydrated", true);
		state.values.set("connections", [
			{ key: "manual:laptop", host: "localhost", port: 4000 },
		]);
		state.params = { conn: "manual:laptop", sessionId: "session-a" };
	});
	test("mounts a visible connection's existing resource screen", () => {
		expect(render()).toContain("Cached transcript and file");
		expect(secretScreen).toHaveBeenCalledOnce();
	});
	test("does not mount content after the connection is hidden by workspace selection", () => {
		state.values.set("connections", []);
		expect(render()).toContain("not available in the selected workspace");
		expect(secretScreen).not.toHaveBeenCalled();
	});
	test("does not show the previous account's content before its catalog has reset", () => {
		state.values.set("account", { id: "account-b" });
		expect(render()).not.toContain("Cached transcript");
		expect(secretScreen).not.toHaveBeenCalled();
	});
	test("unknown raw-host routes cannot mount resource effects", () => {
		state.params = { conn: "127.0.0.1:4000", sessionId: "session-a" };
		expect(render()).toContain("not available");
		expect(secretScreen).not.toHaveBeenCalled();
	});
	test("shows loading rather than content while connection discovery is pending", () => {
		state.values.set("connections", []);
		state.values.set("hydrated", false);
		expect(render()).toContain("Loading");
		expect(secretScreen).not.toHaveBeenCalled();
	});
	test("keeps saved Personal connections available when signed out", () => {
		state.values.set("account", null);
		state.values.set("catalog", { accountId: null, loading: false });
		expect(render()).toContain("Cached transcript and file");
	});
});
