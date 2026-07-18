export type ConnectionFlowNavigator = {
	dismissAll: () => void;
	replace: (href: "/") => void;
};

/** Collapse every connection entry path back into the single root inbox. */
export const returnToInbox = (navigator: ConnectionFlowNavigator): void => {
	navigator.dismissAll();
	navigator.replace("/");
};
