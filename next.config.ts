import type { NextConfig } from "next";

const staticPages = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

const nextConfig: NextConfig = staticPages
  ? {
      output: "export",
      basePath: (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, ""),
      trailingSlash: true,
      // UI entrypoints are .tsx; request-time API handlers are route.ts.
      // Pages cannot execute Node.js. Do not export fake static API responses.
      pageExtensions: ["tsx"],
      images: { unoptimized: true },
    }
  : {};

export default nextConfig;
