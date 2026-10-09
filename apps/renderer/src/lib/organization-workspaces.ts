import { type Organization, STAGING_API_URL } from "@zuse/contracts";
import { createAtomStore } from "../state/atom-store.ts";
import { rendererApiUrl } from "./api-url.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	selectRendererWorkspace,
} from "./renderer-workspace.ts";

/** Production stays hidden until the authenticated capability snapshot arrives. */
export const organizationWorkspacesAvailable = (): boolean => {
	const state = useOrganizationWorkspaces.getState();
	return state.capabilitiesLoaded
		? state.canCreate || state.organizations.length > 0
		: rendererApiUrl() === STAGING_API_URL;
};

export const useOrganizationWorkspaces = createAtomStore<{
	organizations: ReadonlyArray<Organization>;
	loading: boolean;
	error: unknown;
	canCreate: boolean;
	capabilitiesLoaded: boolean;
}>(() => ({
	organizations: [],
	loading: false,
	error: null,
	canCreate: false,
	capabilitiesLoaded: false,
}));

/** Clearing team access must always leave a usable Personal workspace. */
const reconcileSelectedOrganization = (
	organizations: ReadonlyArray<Organization>,
): void => {
	const scope = rendererWorkspaceSnapshot().scope;
	if (
		scope.kind === "organization" &&
		!organizations.some(
			(organization) => organization.id === scope.organizationId,
		)
	)
		selectRendererWorkspace({ kind: "personal" });
};

let pending: Promise<ReadonlyArray<Organization>> | null = null;
let loadedAt = 0;
export const loadOrganizationWorkspaces = (
	refresh = false,
): Promise<ReadonlyArray<Organization>> => {
	if (pending !== null) return pending;
	if (loadedAt > 0 && Date.now() - loadedAt < 30_000 && !refresh)
		return Promise.resolve(useOrganizationWorkspaces.getState().organizations);
	const account = rendererAccountSnapshot();
	useOrganizationWorkspaces.setState({ loading: true, error: null });
	const request = import("./organization-client.ts")
		.then(({ runOrganizations }) => {
			assertRendererAccountCurrent(account);
			return runOrganizations((client) =>
				client["organizations.capabilities"]({}),
			);
		})
		.then(({ organizations, canCreate }) => {
			assertRendererAccountCurrent(account);
			loadedAt = Date.now();
			useOrganizationWorkspaces.setState({
				organizations,
				canCreate,
				capabilitiesLoaded: true,
				loading: false,
				error: null,
			});
			reconcileSelectedOrganization(organizations);
			return organizations;
		})
		.catch((error: unknown) => {
			if (rendererAccountSnapshot() === account) {
				loadedAt = 0;
				useOrganizationWorkspaces.setState({
					error,
					loading: false,
					organizations: [],
					canCreate: false,
					capabilitiesLoaded: true,
				});
				reconcileSelectedOrganization([]);
			}
			throw error;
		})
		.finally(() => {
			if (pending === request) pending = null;
		});
	pending = request;
	return request;
};
subscribeRendererAccount(() => {
	pending = null;
	loadedAt = 0;
	useOrganizationWorkspaces.setState({
		organizations: [],
		loading: false,
		error: null,
		canCreate: false,
		capabilitiesLoaded: false,
	});
});
