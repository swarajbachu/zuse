export const cloudMachinesAvailable = ({
	desktop,
	development,
}: {
	readonly desktop: boolean;
	readonly development: boolean;
}): boolean => desktop && development;
