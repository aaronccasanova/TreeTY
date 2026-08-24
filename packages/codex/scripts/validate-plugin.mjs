import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const packageDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const packageConfigFilePath = path.join(packageDirPath, "package.json");
const pluginConfigFilePath = path.join(
  packageDirPath,
  ".codex-plugin",
  "plugin.json",
);

const packageConfig = readJsonFile(packageConfigFilePath);
const pluginConfig = readJsonFile(pluginConfigFilePath);

if (packageConfig.version !== pluginConfig.version) {
  throw new Error(
    `Codex plugin version ${pluginConfig.version} does not match package version ${packageConfig.version}.`,
  );
}

if (pluginConfig.name !== "treety-codex") {
  throw new Error('Codex plugin name must be "treety-codex".');
}

/** @param {string} jsonFilePath */
function readJsonFile(jsonFilePath) {
  return JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
}
