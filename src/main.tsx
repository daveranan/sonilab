import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { installGlobalErrorHooks } from "./lib/error-hooks";
import { addLogSink } from "./lib/logger";
import "./index.css";

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  addLogSink((event) => {
    void invoke("write_structured_log", { event }).catch(() => undefined);
  });
}

installGlobalErrorHooks({
  exportLocalLogs: () => {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void invoke("export_local_logs").catch(() => undefined);
    }
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
