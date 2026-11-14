import type { JsonValue, ResolvedTreeNode } from "@treety/core";

import type { NodeTreeEntry } from "./tree-provider";
import type { ConfiguredWorkspaceModel, WorkspaceModel } from "./workspace-model";

export interface NodeSearchIdentity {
  workspaceId: string;
  nodeId: string;
}

export interface NodeSearchEntry extends NodeSearchIdentity {
  key: string;
  name: string;
  kind: "group" | "terminal";
  description: string;
  detail: string;
  fields: readonly NodeSearchField[];
}

interface NodeSearchField {
  text: string;
  words: readonly string[];
  initials: string;
  penalty: number;
}

const metadataSearchProperties = [
  "title", "description", "summary", "tags", "labels", "owner", "project",
  "service", "category", "aliases",
] as const;

export function buildNodeSearchEntries(
  workspaceModels: readonly WorkspaceModel[],
): NodeSearchEntry[] {
  const nodeSearchEntries: NodeSearchEntry[] = [];

  for (const workspaceModel of workspaceModels) {
    if (workspaceModel.kind !== "configured") continue;

    appendNodeSearchEntries(nodeSearchEntries, workspaceModel, workspaceModel.resolvedTreeConfig.tree, [], []);
  }

  return nodeSearchEntries;
}

export function searchNodeEntries(
  nodeSearchEntries: readonly NodeSearchEntry[],
  query: string,
): NodeSearchEntry[] {
  if (query.length > 256) return [];

  const queryWords = normalizeSearchText(query).match(/[\p{L}\p{N}]+/gu) ?? [];

  if (queryWords.length === 0) return [...nodeSearchEntries];
  if (queryWords.length > 12 || queryWords.some((queryWord) => queryWord.length > 64)) return [];

  const nodeSearchMatches: { entry: NodeSearchEntry; score: number; index: number }[] = [];

  for (const [index, nodeSearchEntry] of nodeSearchEntries.entries()) {
    let score = 0;
    let matchesEveryWord = true;

    for (const queryWord of queryWords) {
      let bestWordScore = 0;

      for (const nodeSearchField of nodeSearchEntry.fields) {
        bestWordScore = Math.max(bestWordScore, getFieldMatchScore(nodeSearchField, queryWord));
      }

      if (bestWordScore === 0) {
        matchesEveryWord = false;
        break;
      }

      score += bestWordScore;
    }

    if (!matchesEveryWord) continue;

    if (normalizeSearchText(nodeSearchEntry.name) === queryWords.join(" ")) score += 60;

    nodeSearchMatches.push({ entry: nodeSearchEntry, score, index });
  }

  nodeSearchMatches.sort((leftMatch, rightMatch) =>
    rightMatch.score - leftMatch.score || leftMatch.index - rightMatch.index,
  );

  return nodeSearchMatches.map((nodeSearchMatch) => nodeSearchMatch.entry);
}

export function resolveNodeSearchEntry(
  workspaceModels: readonly WorkspaceModel[],
  nodeSearchIdentity: NodeSearchIdentity,
): NodeTreeEntry | undefined {
  const workspaceModel = workspaceModels.find((candidateWorkspaceModel) =>
    candidateWorkspaceModel.id === nodeSearchIdentity.workspaceId,
  );

  if (!workspaceModel || workspaceModel.kind !== "configured") return undefined;

  const treeNode = findTreeNode(workspaceModel.resolvedTreeConfig.tree, nodeSearchIdentity.nodeId);

  if (!treeNode) return undefined;

  return { kind: "node", workspaceModel, treeNode };
}

function appendNodeSearchEntries(
  nodeSearchEntries: NodeSearchEntry[],
  workspaceModel: ConfiguredWorkspaceModel,
  treeNodes: readonly ResolvedTreeNode[],
  ancestorNames: readonly string[],
  ancestorMetadata: readonly string[],
): void {
  for (const treeNode of treeNodes) {
    const metadataSummary = getMetadataSummary(treeNode.metadata);
    const description = [workspaceModel.name, ...ancestorNames].join(" > ");
    const directorySummary = treeNode.projectDir && treeNode.projectDir !== treeNode.cwd
      ? `${treeNode.cwd} | Project: ${treeNode.projectDir}`
      : treeNode.cwd;
    const metadataContext = [...ancestorMetadata, metadataSummary].filter(Boolean).join(" | ");

    nodeSearchEntries.push({
      key: JSON.stringify([workspaceModel.id, treeNode.id]),
      workspaceId: workspaceModel.id,
      nodeId: treeNode.id,
      name: treeNode.name,
      kind: treeNode.kind,
      description,
      detail: [directorySummary, metadataContext].filter(Boolean).join(" | "),
      fields: [
        buildSearchField(treeNode.name, 0),
        buildSearchField(description, 18),
        buildSearchField(metadataSummary, 24),
        buildSearchField(ancestorMetadata.join(" "), 28),
        buildSearchField(directorySummary, 30),
        buildSearchField(treeNode.id, 36),
      ].filter((searchField) => searchField.text !== ""),
    });

    if (treeNode.kind !== "group") continue;

    appendNodeSearchEntries(
      nodeSearchEntries,
      workspaceModel,
      treeNode.children,
      [...ancestorNames, treeNode.name],
      metadataSummary ? [...ancestorMetadata, `${treeNode.name}: ${metadataSummary}`] : ancestorMetadata,
    );
  }
}

function getMetadataSummary(metadata: JsonValue | undefined): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";

  const metadataDescriptions: string[] = [];

  for (const propertyName of metadataSearchProperties) {
    const metadataValue = metadata[propertyName];
    const metadataValues = Array.isArray(metadataValue) ? metadataValue.slice(0, 16) : [metadataValue];
    const metadataText = metadataValues
      .filter((metadataItem): metadataItem is string => typeof metadataItem === "string")
      .map((metadataItem) => metadataItem.replace(/\s+/g, " ").slice(0, 240))
      .join(", ");

    if (metadataText) metadataDescriptions.push(`${propertyName}: ${metadataText}`);
  }

  return metadataDescriptions.join(" | ").slice(0, 1024);
}

function buildSearchField(text: string, penalty: number): NodeSearchField {
  const searchText = normalizeSearchText(text).slice(0, 2048);
  const words = searchText.match(/[\p{L}\p{N}]+/gu) ?? [];

  return {
    text: searchText,
    words,
    initials: words.map((word) => word[0]).join(""),
    penalty,
  };
}

function normalizeSearchText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function getFieldMatchScore(searchField: NodeSearchField, queryWord: string): number {
  if (searchField.text === queryWord) return 120 - searchField.penalty;
  if (searchField.words.includes(queryWord)) return 110 - searchField.penalty;
  if (searchField.text.startsWith(queryWord)) return 104 - searchField.penalty;
  if (searchField.words.some((word) => word.startsWith(queryWord))) return 100 - searchField.penalty;
  if (queryWord.length >= 2 && searchField.initials.includes(queryWord)) return 96 - searchField.penalty;
  if (queryWord.length >= 2 && searchField.text.includes(queryWord)) return 90 - searchField.penalty;

  if (queryWord.length < 2) return 0;

  const matchGap = getSubsequenceMatchGap(searchField.text, queryWord);
  let matchScore = matchGap === undefined
    ? 0
    : 78 - Math.min(matchGap, 20) - searchField.penalty;

  if (queryWord.length < 3) return Math.max(0, matchScore);

  const maximumDistance = queryWord.length >= 6 ? 2 : 1;

  for (const word of searchField.words) {
    if (Math.abs(word.length - queryWord.length) > maximumDistance || word.length > 64) continue;

    const editDistance = getEditDistance(queryWord, word, maximumDistance);

    if (editDistance > maximumDistance) continue;

    matchScore = Math.max(matchScore, 78 - editDistance * 8 - searchField.penalty);
  }

  return Math.max(0, matchScore);
}

function getSubsequenceMatchGap(text: string, queryWord: string): number | undefined {
  let bestMatchGap: number | undefined;
  let firstMatchIndex = text.indexOf(queryWord[0] ?? "");

  while (firstMatchIndex !== -1) {
    let lastMatchIndex = firstMatchIndex;
    let queryIndex = 1;

    for (; queryIndex < queryWord.length; queryIndex += 1) {
      lastMatchIndex = text.indexOf(queryWord[queryIndex] ?? "", lastMatchIndex + 1);

      if (lastMatchIndex === -1 || lastMatchIndex - firstMatchIndex > queryWord.length * 4) break;
    }

    if (queryIndex === queryWord.length) {
      const matchGap = lastMatchIndex - firstMatchIndex + 1 - queryWord.length;

      bestMatchGap = Math.min(bestMatchGap ?? Infinity, matchGap);
    }

    firstMatchIndex = text.indexOf(queryWord[0] ?? "", firstMatchIndex + 1);
  }

  return bestMatchGap;
}

function getEditDistance(leftWord: string, rightWord: string, maximumDistance: number): number {
  let previousPreviousRow: number[] = [];
  let previousRow = Array.from({ length: rightWord.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= leftWord.length; leftIndex += 1) {
    const currentRow = [leftIndex];
    let minimumDistance = leftIndex;

    for (let rightIndex = 1; rightIndex <= rightWord.length; rightIndex += 1) {
      const substitutionCost = leftWord[leftIndex - 1] === rightWord[rightIndex - 1] ? 0 : 1;
      let distance = Math.min(
        (previousRow[rightIndex] ?? 0) + 1,
        (currentRow[rightIndex - 1] ?? 0) + 1,
        (previousRow[rightIndex - 1] ?? 0) + substitutionCost,
      );

      if (
        leftIndex > 1 && rightIndex > 1 &&
        leftWord[leftIndex - 1] === rightWord[rightIndex - 2] &&
        leftWord[leftIndex - 2] === rightWord[rightIndex - 1]
      ) {
        distance = Math.min(distance, (previousPreviousRow[rightIndex - 2] ?? 0) + 1);
      }

      currentRow.push(distance);
      minimumDistance = Math.min(minimumDistance, distance);
    }

    if (minimumDistance > maximumDistance) return maximumDistance + 1;

    previousPreviousRow = previousRow;
    previousRow = currentRow;
  }

  return previousRow[rightWord.length] ?? maximumDistance + 1;
}

function findTreeNode(treeNodes: readonly ResolvedTreeNode[], nodeId: string): ResolvedTreeNode | undefined {
  for (const treeNode of treeNodes) {
    if (treeNode.id === nodeId) return treeNode;
    if (treeNode.kind !== "group") continue;

    const descendantTreeNode = findTreeNode(treeNode.children, nodeId);

    if (descendantTreeNode) return descendantTreeNode;
  }

  return undefined;
}
