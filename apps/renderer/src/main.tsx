import React from "react";
import ReactDOM from "react-dom/client";

import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { App } from "./app";
import { ToastProvider } from "./components/ui/toast.tsx";

if (import.meta.env.DEV) {
  void import("./lib/update-demo.ts").then((m) => m.installUpdateDemo());
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing in index.html");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
