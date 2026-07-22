import { defineConfig } from "vite-plus";

import serverPack from "./tsdown.config.ts";

export default defineConfig({
	pack: serverPack,
});
