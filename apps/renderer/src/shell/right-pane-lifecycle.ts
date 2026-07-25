/**
 * Whether the right-pane controller should be mounted. The dock can collapse
 * visually, but its browser command subscription must remain alive.
 */
export const shouldMountRightPane = (_rightSidebarOpen: boolean): boolean =>
	true;
