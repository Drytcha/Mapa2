import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// GitHub Pages serwuje repo pod /Mapa2/, więc assets muszą mieć ten prefiks.
// Lokalnie (bez env) używamy "/", żeby `npm run dev` działał pod localhost:5173/.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH
  ? `${process.env.NEXT_PUBLIC_BASE_PATH.replace(/\/+$/, "")}/`
  : "/";

// https://vite.dev/config/
export default defineConfig({
  base: basePath,
  server: {
    host: "0.0.0.0",
    allowedHosts: [".e2b.app"],
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});