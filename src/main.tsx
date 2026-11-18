import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import { installEmbeddedGtfs } from "./embeddedGtfs";
import App from "./App";

installEmbeddedGtfs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
