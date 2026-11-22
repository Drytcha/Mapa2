import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import { installEmbeddedGtfs } from "./embeddedGtfs";
import { warmUpStorage } from "./lib/engine/storage";
import App from "./App";

installEmbeddedGtfs();
// Baza IndexedDB (rozklad, obserwacje GPS) otwiera sie od razu, rownolegle
// z pobieraniem i parsowaniem GTFS — nie blokuje pierwszego ekranu.
warmUpStorage();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
