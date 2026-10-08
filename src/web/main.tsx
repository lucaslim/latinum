import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { SessionGate } from "./components/SessionGate.tsx";
import "./theme/tokens.css";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <SessionGate>{(onLogOut) => <App onLogOut={onLogOut} />}</SessionGate>
  </StrictMode>,
);
