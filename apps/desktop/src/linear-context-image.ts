const IMAGE_EXTENSIONS = new Set([
	"avif",
	"gif",
	"jpeg",
	"jpg",
	"png",
	"svg",
	"webp",
]);

export const isLinearContextImagePath = (path: string): boolean => {
	const segments = path
		.split(/[\\/]+/u)
		.filter((segment) => segment.length > 0);
	const contextIndex = segments.lastIndexOf(".context");
	if (contextIndex === -1 || segments[contextIndex + 1] !== "linear") {
		return false;
	}
	const tail = segments.slice(contextIndex + 2);
	if (tail.length !== 4 || tail[1] !== "assets") return false;
	const filename = tail[3];
	if (filename === undefined) return false;
	const dot = filename.lastIndexOf(".");
	if (dot <= 0) return false;
	return IMAGE_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
};
