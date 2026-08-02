import { SECTION_LABELS } from "./site";
import { source } from "./source";

export type NavItem = {
	readonly title: string;
	readonly description: string;
	readonly url: string;
	readonly section: string;
	readonly order: number;
};

export type NavSection = {
	readonly id: string;
	readonly title: string;
	readonly items: ReadonlyArray<NavItem>;
};

export function getNavigation(): ReadonlyArray<NavSection> {
	const pages = source.getPages().map((page) => ({
		title: page.data.title,
		description: page.data.description,
		url: page.url,
		section: page.data.section,
		order: page.data.order,
	}));

	return Object.entries(SECTION_LABELS)
		.map(([id, title]) => ({
			id,
			title,
			items: pages
				.filter((page) => page.section === id || page.section === title)
				.sort((left, right) => left.order - right.order),
		}))
		.filter((section) => section.items.length > 0);
}

export function getAdjacentPages(url: string) {
	const flat = getNavigation().flatMap((section) => section.items);
	const index = flat.findIndex((page) => page.url === url);
	return {
		previous: index > 0 ? flat[index - 1] : undefined,
		next: index >= 0 ? flat[index + 1] : undefined,
	};
}

export function getPageByPath(pathname: string) {
	const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return source.getPages().find((page) => page.url === normalized);
}

export function getBacklinks(pathname: string): ReadonlyArray<NavItem> {
	const normalized = pathname.replace(/\/$/u, "") || "/";
	return source
		.getPages()
		.filter((page) => {
			if (page.url === normalized) return false;
			const declared = [
				...page.data.related,
				...page.data.prerequisites,
				...(page.data.next ? [page.data.next] : []),
			].map((value) => value.replace(/\/$/u, "") || "/");
			const markdownLinks = Array.from(
				(page.data._raw.body ?? "").matchAll(/\]\((\/[^)#\s]+)(?:#[^)]+)?\)/gu),
				(match) => match[1].replace(/\/$/u, "") || "/",
			);
			return (
				declared.includes(normalized) || markdownLinks.includes(normalized)
			);
		})
		.map((page) => ({
			title: page.data.title,
			description: page.data.description,
			url: page.url,
			section: page.data.section,
			order: page.data.order,
		}))
		.sort((left, right) => left.order - right.order);
}
