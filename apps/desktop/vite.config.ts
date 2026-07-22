import { defineConfig } from "vite-plus";

import desktopPack from "./tsdown.config.ts";

export default defineConfig({
	pack: desktopPack,
});
