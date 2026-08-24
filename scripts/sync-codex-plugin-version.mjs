#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const codexPackageConfigFilePath = path.join(
  projectRootDirPath,
  "packages",
  "codex",
  "package.json",
);
const codexPluginConfigFilePath = path.join(
  projectRootDirPath,
  "packages",
  "codex",
  ".codex-plugin",
  "plugin.json",
);

const codexPackageConfig = readJsonFile(codexPackageConfigFilePath);
const codexPluginConfig = readJsonFile(codexPluginConfigFilePath);

if (typeof codexPackageConfig.version !== "string") {
  throw new Error("Codex package version must be a string.");
}

if (codexPluginConfig.version === codexPackageConfig.version) process.exit(0);

const codexPluginConfigWithVersion = {
  ...codexPluginConfig,
  version: codexPackageConfig.version,
};

fs.writeFileSync(
  codexPluginConfigFilePath,
  `${JSON.stringify(codexPluginConfigWithVersion, null, 2)}\n`,
);

function readJsonFile(jsonFilePath) {
  return JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
}
