import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./charts.css";
import "./mcp.css";
import "./connections.css";
import "./dock3.css";
import "./agent.css";
import "@xterm/xterm/css/xterm.css";
import "./workbench.css";
import "./gcp.css";
import "./landflow.css";
import "./views.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
