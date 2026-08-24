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
const marketplaceConfigFilePath = path.join(
  packageDirPath,
  "..",
  "..",
  ".agents",
  "plugins",
  "marketplace.json",
);

const packageConfig = readJsonFile(packageConfigFilePath);
const pluginConfig = readJsonFile(pluginConfigFilePath);
const marketplaceConfig = readJsonFile(marketplaceConfigFilePath);

if (packageConfig.version !== pluginConfig.version) {
  throw new Error(
    `Codex plugin version ${pluginConfig.version} does not match package version ${packageConfig.version}.`,
  );
}

if (pluginConfig.name !== "treety-codex") {
  throw new Error('Codex plugin name must be "treety-codex".');
}

if (marketplaceConfig.name !== "treety") {
  throw new Error('Codex marketplace name must be "treety".');
}

const marketplacePluginConfig = marketplaceConfig.plugins?.[0];

if (marketplacePluginConfig?.name !== pluginConfig.name) {
  throw new Error("Codex marketplace must contain the TreeTY Codex plugin.");
}

if (marketplacePluginConfig.source?.source !== "local") {
  throw new Error("Codex marketplace plugin source must be local.");
}

if (marketplacePluginConfig.source.path !== "./packages/codex") {
  throw new Error(
    'Codex marketplace plugin source path must be "./packages/codex".',
  );
}

/** @param {string} jsonFilePath */
function readJsonFile(jsonFilePath) {
  return JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
}
