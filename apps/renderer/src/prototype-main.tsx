import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

import { CloudRunSupervisionPrototype } from "./components/prototypes/cloud-run-supervision-prototype.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing in cloud-run-prototype.html");

if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
	document.documentElement.classList.add("dark");
}

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<TooltipProvider>
			<CloudRunSupervisionPrototype />
		</TooltipProvider>
	</React.StrictMode>,
);
