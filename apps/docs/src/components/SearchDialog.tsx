import { useDocsSearch } from "fumadocs-core/search/client";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type SearchItem = {
	readonly title: string;
	readonly description: string;
	readonly url: string;
	readonly section: string;
};

const cleanText = (value: string): string =>
	value.replace(/<[^>]+>/gu, "").replace(/[`*_]/gu, "");

function Highlight({
	text,
	query,
}: {
	readonly text: string;
	readonly query: string;
}) {
	const value = query.trim();
	if (!value) return text;
	const index = text.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
	if (index < 0) return text;
	return (
		<>
			{text.slice(0, index)}
			<mark>{text.slice(index, index + value.length)}</mark>
			{text.slice(index + value.length)}
		</>
	);
}

export function SearchDialog({
	items,
}: {
	readonly items: ReadonlyArray<SearchItem>;
}) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const { search, setSearch, query } = useDocsSearch({
		type: "static",
		from: "/api/search",
		delayMs: 80,
	});
	const itemByUrl = useMemo(
		() => new Map(items.map((item) => [item.url, item])),
		[items],
	);
	const results = useMemo(() => {
		if (!search.trim())
			return items
				.slice(0, 8)
				.map((item) => ({ ...item, content: item.title }));
		if (query.data === "empty" || !query.data) return [];
		return query.data.slice(0, 10).map((result) => {
			const pageUrl = result.url.split("#", 1)[0];
			const page = itemByUrl.get(pageUrl);
			return {
				title:
					result.type === "page"
						? cleanText(result.content)
						: (page?.title ?? cleanText(result.content)),
				description:
					result.type === "page"
						? (page?.description ?? "")
						: cleanText(result.content),
				url: result.url,
				section:
					page?.section ??
					cleanText(result.breadcrumbs?.[0] ?? "Documentation"),
				content: result.content,
			};
		});
	}, [itemByUrl, items, query.data, search]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setOpen((value) => !value);
			}
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		if (open) requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((value) => Math.min(value + 1, results.length - 1));
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((value) => Math.max(value - 1, 0));
		}
	};
	const onSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
		event.preventDefault();
		const selected = results[activeIndex] ?? results[0];
		if (selected) window.location.assign(selected.url);
	};

	return (
		<>
			<button
				className="search-trigger"
				type="button"
				onClick={() => setOpen(true)}
				aria-label="Search documentation"
			>
				<Search aria-hidden="true" size={15} />
				<span>Search docs</span>
				<kbd>⌘K</kbd>
			</button>
			{open ? (
				<div className="search-overlay">
					<button
						className="search-backdrop"
						type="button"
						aria-label="Close search"
						onClick={() => setOpen(false)}
					/>
					<section
						className="search-dialog"
						role="dialog"
						aria-modal="true"
						aria-label="Search documentation"
						onMouseDown={(event) => event.stopPropagation()}
					>
						<form className="search-input-row" onSubmit={onSubmit}>
							<Search aria-hidden="true" size={18} />
							<input
								ref={inputRef}
								value={search}
								onChange={(event) => {
									setSearch(event.target.value);
									setActiveIndex(0);
								}}
								onKeyDown={onInputKeyDown}
								placeholder="Search guides, commands, and concepts"
								aria-label="Search documentation"
								aria-activedescendant={
									results[activeIndex]
										? `search-result-${activeIndex}`
										: undefined
								}
							/>
							<button
								className="icon-button"
								type="button"
								onClick={() => setOpen(false)}
								aria-label="Close search"
							>
								<X aria-hidden="true" size={17} />
							</button>
						</form>
						<div className="search-results" aria-live="polite">
							{query.isLoading ? (
								<p className="search-empty">Searching…</p>
							) : null}
							{!query.isLoading && results.length === 0 ? (
								<p className="search-empty">No matching documentation.</p>
							) : null}
							{results.map((item, index) => (
								<a
									id={`search-result-${index}`}
									key={item.url}
									className="search-result"
									data-active={index === activeIndex ? "true" : undefined}
									href={item.url}
									onMouseEnter={() => setActiveIndex(index)}
								>
									<span className="search-result-section">{item.section}</span>
									<strong>
										<Highlight text={item.title} query={search} />
									</strong>
									<span>
										<Highlight text={item.description} query={search} />
									</span>
								</a>
							))}
						</div>
					</section>
				</div>
			) : null}
		</>
	);
}
