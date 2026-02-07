import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: currentDir,
  },
  outputFileTracingRoot: currentDir,
};

export default nextConfig;
