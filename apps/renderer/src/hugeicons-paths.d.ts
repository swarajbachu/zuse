type ZuseIconSvgObject =
	| Array<[string, Record<string, string | number>]>
	| ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

declare module "@hugeicons-pro/core-solid-rounded/*" {
	const icon: ZuseIconSvgObject;
	export default icon;
}

declare module "@hugeicons-pro/core-bulk-rounded/*" {
	const icon: ZuseIconSvgObject;
	export default icon;
}
