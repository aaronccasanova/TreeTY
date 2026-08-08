import * as fs from "node:fs/promises";
import * as path from "node:path";

import { formatTreeConfigContent, parseTreeConfigContent } from "./config";
import {
  getFileErrorCode,
  loadDocumentFile,
  mutateDocumentFile,
} from "./file-storage";
import { TreeConfig } from "./model";
import { pruneTreeStateFile } from "./state";

const treeTYGitignoreEntries = ["state.json", "*.state.json", "*.lock", ".*.tmp"];

export async function loadTreeConfigFile(
  treeConfigFilePath: string,
): Promise<TreeConfig> {
  try {
    return await loadDocumentFile(
      treeConfigFilePath,
      parseTreeConfigContent,
    );
  } catch (error) {
    if (getFileErrorCode(error) === "ENOENT") {
      throw new Error(
        `No TreeTY configuration exists at ${treeConfigFilePath}. Run "treety init" first.`,
      );
    }

    throw error;
  }
}

export async function mutateTreeConfigFile<Result = TreeConfig>(
  treeConfigFilePath: string,
  mutateTreeConfig: (treeConfig: TreeConfig) => TreeConfig | Promise<TreeConfig>,
  getTransactionResult: (treeConfig: TreeConfig) => Result = (treeConfig) =>
    treeConfig as unknown as Result,
): Promise<Result> {
  let updatedTreeConfig: TreeConfig | undefined;

  const transactionResult = await mutateDocumentFile(
    treeConfigFilePath,
    parseTreeConfigContent,
    formatTreeConfigContent,
    async (treeConfig) => {
      updatedTreeConfig = await mutateTreeConfig(treeConfig);

      return updatedTreeConfig;
    },
    getTransactionResult,
  );

  if (updatedTreeConfig) {
    await pruneTreeStateFile(treeConfigFilePath, updatedTreeConfig).catch(
      () => undefined,
    );
  }

  return transactionResult;
}

export async function writeTreeConfigFile(
  treeConfigFilePath: string,
  treeConfig: TreeConfig,
): Promise<void> {
  await mutateDocumentFile(
    treeConfigFilePath,
    (treeConfigFileContent) => {
      try {
        return parseTreeConfigContent(treeConfigFileContent);
      } catch {
        return treeConfig;
      }
    },
    formatTreeConfigContent,
    () => treeConfig,
    () => undefined,
    { createDocument: () => treeConfig },
  );

  await ensureTreeTYGitignore(treeConfigFilePath);
  await pruneTreeStateFile(treeConfigFilePath, treeConfig).catch(
    () => undefined,
  );
}

export async function ensureTreeTYGitignore(
  treeConfigFilePath: string,
): Promise<void> {
  const treeConfigDirPath = path.dirname(treeConfigFilePath);

  if (path.basename(treeConfigDirPath) !== ".treety") return;

  const gitignoreFilePath = path.join(treeConfigDirPath, ".gitignore");
  let gitignoreFileContent = "";

  try {
    gitignoreFileContent = await fs.readFile(gitignoreFilePath, "utf8");
  } catch (error) {
    if (getFileErrorCode(error) !== "ENOENT") throw error;
  }

  const gitignoreLines = new Set(
    gitignoreFileContent.split(/\r?\n/).filter((gitignoreLine) => gitignoreLine),
  );

  for (const treeTYGitignoreEntry of treeTYGitignoreEntries) {
    gitignoreLines.add(treeTYGitignoreEntry);
  }

  await fs.writeFile(
    gitignoreFilePath,
    `${[...gitignoreLines].join("\n")}\n`,
    "utf8",
  );
}
