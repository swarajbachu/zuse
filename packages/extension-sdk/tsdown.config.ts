import { defineConfig } from "tsdown";
export default defineConfig({
	entry: ["src/index.ts", "src/server.ts", "src/client.tsx", "src/host.ts"],
	format: "esm",
	dts: true,
	clean: true,
	deps: { neverBundle: ["react", "react/jsx-runtime", "effect"] },
});
