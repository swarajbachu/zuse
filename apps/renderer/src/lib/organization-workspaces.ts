import { type Organization, STAGING_API_URL } from "@zuse/contracts";
import { createAtomStore } from "../state/atom-store.ts";
import { rendererApiUrl } from "./api-url.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";

export const organizationWorkspacesAvailable = (): boolean =>
	rendererApiUrl() === STAGING_API_URL ||
	import.meta.env.VITE_ORGANIZATION_WORKSPACES === "true";

export const useOrganizationWorkspaces = createAtomStore<{
	organizations: ReadonlyArray<Organization>;
	loading: boolean;
	error: unknown;
}>(() => ({ organizations: [], loading: false, error: null }));

let pending: Promise<ReadonlyArray<Organization>> | null = null;
let loaded = false;
export const loadOrganizationWorkspaces = (
	refresh = false,
): Promise<ReadonlyArray<Organization>> => {
	if (pending !== null) return pending;
	if (loaded && !refresh)
		return Promise.resolve(useOrganizationWorkspaces.getState().organizations);
	const account = rendererAccountSnapshot();
	useOrganizationWorkspaces.setState({ loading: true, error: null });
	const request = import("./organization-client.ts")
		.then(({ runOrganizations }) => {
			assertRendererAccountCurrent(account);
			return runOrganizations((client) => client["organizations.list"]({}));
		})
		.then((organizations) => {
			assertRendererAccountCurrent(account);
			loaded = true;
			useOrganizationWorkspaces.setState({ organizations, loading: false });
			return organizations;
		})
		.catch((error: unknown) => {
			if (rendererAccountSnapshot() === account)
				useOrganizationWorkspaces.setState({ error, loading: false });
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
	loaded = false;
	useOrganizationWorkspaces.setState({
		organizations: [],
		loading: false,
		error: null,
	});
});
