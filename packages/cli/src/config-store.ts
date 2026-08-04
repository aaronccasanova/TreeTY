import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  formatTreeConfigContent,
  parseTreeConfigContent,
  treeTYConfigFileEnvironmentName,
  TreeConfig,
} from "@treety/core";

export interface TreeConfigLocationOptions {
  configFileName?: string;
  currentDirPath: string;
  environment: NodeJS.ProcessEnv;
  homeDirPath: string;
  initialize?: boolean;
  useGlobal?: boolean;
}

export async function resolveTreeConfigFilePath(
  options: TreeConfigLocationOptions,
): Promise<string> {
  if (options.configFileName) {
    return path.resolve(options.currentDirPath, options.configFileName);
  }

  const globalConfigFilePath = getGlobalConfigFilePath(options);

  if (options.useGlobal) return globalConfigFilePath;

  const sessionConfigFileName =
    options.environment[treeTYConfigFileEnvironmentName];

  if (sessionConfigFileName) {
    return path.resolve(options.currentDirPath, sessionConfigFileName);
  }

  const workspaceConfigFilePath = path.join(
    options.currentDirPath,
    ".treety",
    "tree.json",
  );

  if (options.initialize) return workspaceConfigFilePath;
  if (await getFileExists(workspaceConfigFilePath)) {
    return workspaceConfigFilePath;
  }

  if (await getFileExists(globalConfigFilePath)) return globalConfigFilePath;

  return workspaceConfigFilePath;
}

export async function loadTreeConfig(
  treeConfigFilePath: string,
): Promise<TreeConfig> {
  let treeConfigFileContent: string;

  try {
    treeConfigFileContent = await fs.readFile(treeConfigFilePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `No TreeTY configuration exists at ${treeConfigFilePath}. Run "treety init" first.`,
      );
    }

    throw error;
  }

  return parseTreeConfigContent(treeConfigFileContent);
}

export async function writeTreeConfig(
  treeConfigFilePath: string,
  treeConfig: TreeConfig,
): Promise<void> {
  const treeConfigDirPath = path.dirname(treeConfigFilePath);
  const temporaryConfigFilePath = path.join(
    treeConfigDirPath,
    `.tree-${process.pid}-${Date.now()}.json`,
  );

  await fs.mkdir(treeConfigDirPath, { recursive: true });
  await fs.writeFile(
    temporaryConfigFilePath,
    formatTreeConfigContent(treeConfig),
    "utf8",
  );
  await fs.rename(temporaryConfigFilePath, treeConfigFilePath);
}

export async function getFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);

    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;

    throw error;
  }
}

function getGlobalConfigFilePath(
  options: TreeConfigLocationOptions,
): string {
  const globalConfigDirPath = options.environment.XDG_CONFIG_HOME
    ? path.resolve(options.environment.XDG_CONFIG_HOME)
    : path.join(options.homeDirPath, ".config");

  return path.join(globalConfigDirPath, "treety", "tree.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}
