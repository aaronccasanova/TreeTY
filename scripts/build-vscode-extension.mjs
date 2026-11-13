#!/usr/bin/env node

import * as fs from "node:fs";
import * as module from "node:module";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
const extensionRequire = module.createRequire(
  path.join(extensionDirPath, "package.json"),
);
const esbuild = extensionRequire("esbuild");

async function main() {
  const extensionDistDirPath = path.join(extensionDirPath, "dist");

  fs.mkdirSync(extensionDistDirPath, { recursive: true });

  await esbuild.build({
    alias: {
      "@treety/core": path.join(
        projectRootDirPath,
        "packages",
        "core",
        "src",
        "index.ts",
      ),
    },
    bundle: true,
    entryPoints: {
      extension: path.join(extensionDirPath, "src", "extension.ts"),
      cli: path.join(projectRootDirPath, "packages", "cli", "src", "cli.ts"),
    },
    external: ["vscode"],
    format: "cjs",
    outdir: extensionDistDirPath,
    platform: "node",
    sourcemap: true,
    target: "node20",
  });
}

await main();
