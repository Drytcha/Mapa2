import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OVERRIDES_FILE = path.resolve(__dirname, "src/data/line-route-overrides.json");
const MAX_OVERRIDES_BODY_BYTES = 12 * 1024 * 1024;

function lineRouteOverridesDevApi(): Plugin {
  return {
    name: "line-route-overrides-dev-api",
    configureServer(server) {
      server.middlewares.use("/api/line-route-overrides", (req, res, next) => {
        if (req.method === "GET") {
          try {
            const raw = fs.existsSync(OVERRIDES_FILE)
              ? fs.readFileSync(OVERRIDES_FILE, "utf8")
              : JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), overrides: {} });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(raw);
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: String(error) }));
          }
          return;
        }

        if (req.method === "PUT") {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          req.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes <= MAX_OVERRIDES_BODY_BYTES) {
              chunks.push(chunk);
            }
          });
          req.on("end", () => {
            if (totalBytes > MAX_OVERRIDES_BODY_BYTES) {
              res.statusCode = 413;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: "Payload too large" }));
              return;
            }
            try {
              const rawText = Buffer.concat(chunks).toString("utf8");
              const parsed = JSON.parse(rawText) as {
                version?: unknown;
                updatedAt?: unknown;
                overrides?: unknown;
              };
              if (
                !parsed ||
                typeof parsed !== "object" ||
                !parsed.overrides ||
                typeof parsed.overrides !== "object" ||
                Array.isArray(parsed.overrides)
              ) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ error: "Invalid overrides payload" }));
                return;
              }
              const formatted = `${JSON.stringify(
                {
                  version: 1,
                  updatedAt:
                    typeof parsed.updatedAt === "string"
                      ? parsed.updatedAt
                      : new Date().toISOString(),
                  overrides: parsed.overrides,
                },
                null,
                2,
              )}\n`;
              fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
              const tmpFile = `${OVERRIDES_FILE}.tmp`;
              fs.writeFileSync(tmpFile, formatted, "utf8");
              fs.renameSync(tmpFile, OVERRIDES_FILE);
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: true }));
            } catch (error) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: String(error) }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

// GitHub Pages serwuje repo pod /Mapa2/, więc assets muszą mieć ten prefiks.
// Lokalnie (bez env) używamy "/", żeby `npm run dev` działał pod localhost:5173/.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH
  ? `${process.env.NEXT_PUBLIC_BASE_PATH.replace(/\/+$/, "")}/`
  : "/";

// Domyślny build dzieli kod na lekkie chunki ładowane na żądanie (React.lazy +
// osobne paczki vendorów i walbrzych-gtfs.zip z cache HTTP). Jednoplikowy
// wariant offline nadal można zbudować poleceniem `npm run build:singlefile`.
const singleFileBuild =
  process.env.SINGLEFILE === "1" || process.env.SINGLEFILE === "true";

// https://vite.dev/config/
export default defineConfig({
  base: basePath,
  server: {
    host: "0.0.0.0",
    allowedHosts: [".e2b.app"],
  },
  worker: {
    format: "es",
  },
  plugins: [
    lineRouteOverridesDevApi(),
    react(),
    tailwindcss(),
    ...(singleFileBuild ? [viteSingleFile()] : []),
  ],
  build: singleFileBuild
    ? undefined
    : {
        // Nie pakuj dużych archiwów (walbrzych-gtfs.zip) jako base64 w JS.
        assetsInlineLimit: 4096,
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (id.includes("line-route-overrides.json")) {
                return "data-route-overrides";
              }
              if (!id.includes("node_modules")) return undefined;
              if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
                return "vendor-react";
              }
              if (id.includes("leaflet")) return "vendor-leaflet";
              if (id.includes("fflate")) return "vendor-zip";
              if (id.includes("lucide-react")) return "vendor-icons";
              if (id.includes("luxon")) return "vendor-luxon";
              return undefined;
            },
          },
        },
      },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
