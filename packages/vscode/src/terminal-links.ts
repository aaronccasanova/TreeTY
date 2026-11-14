import type { NodeTreeEntry } from "./tree-provider";
import type { WorkspaceModel } from "./workspace-model";

export interface TerminalLinkTarget {
  configUri: string;
  nodeId: string;
  sessionId: string;
}

export interface TerminalLinkUri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}

interface TerminalLinkManagerOptions {
  extensionId: string;
  uriScheme: string;
  remoteName?: string;
  resolveExternalUri(uri: TerminalLinkUri): PromiseLike<string>;
}

interface HandleTerminalLinkOptions {
  startup: Promise<void>;
  terminalLinks: TerminalLinkManager;
  uri: TerminalLinkUri;
  revealTerminalLink(target: TerminalLinkTarget): Promise<void>;
}

interface RevealTerminalLinkOptions {
  target: TerminalLinkTarget;
  workspaceModels: readonly WorkspaceModel[];
  validateTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void>;
  clearAttention(nodeTreeEntry: NodeTreeEntry): Promise<void>;
}

export class TerminalLinkManager {
  public constructor(private readonly options: TerminalLinkManagerOptions) {}

  public async createTerminalLink(target: TerminalLinkTarget): Promise<string> {
    this.assertLocalWindow();
    validateTerminalLinkTarget(target);

    return await this.options.resolveExternalUri({
      scheme: this.options.uriScheme,
      authority: this.options.extensionId.toLowerCase(),
      path: "/open",
      query: new URLSearchParams({
        configUri: target.configUri,
        nodeId: target.nodeId,
        sessionId: target.sessionId,
      }).toString(),
      fragment: "",
    });
  }

  public parseTerminalLink(uri: TerminalLinkUri): TerminalLinkTarget {
    this.assertLocalWindow();

    if (
      uri.scheme !== this.options.uriScheme ||
      uri.authority.toLowerCase() !== this.options.extensionId.toLowerCase() ||
      uri.path !== "/open" ||
      uri.fragment
    ) {
      throw new Error("This is not a supported TreeTY terminal link.");
    }

    try {
      decodeURIComponent(uri.query.replaceAll("+", " "));
    } catch {
      throw new Error("The TreeTY terminal link has invalid query encoding.");
    }

    // VS Code has already decoded the URI query. Keep platform routing fields opaque.
    const query = new URLSearchParams(uri.query);
    const target = {
      configUri: getRequiredQueryValue(query, "configUri"),
      nodeId: getRequiredQueryValue(query, "nodeId"),
      sessionId: getRequiredQueryValue(query, "sessionId"),
    };

    validateTerminalLinkTarget(target);

    return target;
  }

  private assertLocalWindow(): void {
    if (!this.options.remoteName) return;

    throw new Error("Terminal links currently require a local desktop VS Code window.");
  }
}

export async function handleTerminalLink(
  options: HandleTerminalLinkOptions,
): Promise<void> {
  await options.startup;

  const target = options.terminalLinks.parseTerminalLink(options.uri);

  await options.revealTerminalLink(target);
}

export async function revealTerminalLink(
  options: RevealTerminalLinkOptions,
): Promise<void> {
  const nodeTreeEntry = getTerminalLinkNodeTreeEntry(
    options.workspaceModels,
    options.target,
  );

  await options.validateTerminal(nodeTreeEntry);

  const sessions =
    await nodeTreeEntry.workspaceModel.vscodeTerminalHost.getSessions();
  const session = sessions.find(
    (candidateSession) =>
      candidateSession.id === options.target.sessionId &&
      candidateSession.nodeId === options.target.nodeId,
  );

  if (!session) {
    throw new Error(
      "This terminal session is no longer running in this window. Open the terminal in its original window and copy a new link.",
    );
  }

  nodeTreeEntry.workspaceModel.vscodeTerminalHost.revealSession(session.id);

  await options.clearAttention(nodeTreeEntry);
}

export function getTerminalLinkNodeTreeEntry(
  workspaceModels: readonly WorkspaceModel[],
  target: TerminalLinkTarget,
): NodeTreeEntry {
  const workspaceModel = workspaceModels.find(
    (candidateWorkspaceModel) =>
      candidateWorkspaceModel.configFileUri.toString() === target.configUri,
  );

  if (!workspaceModel) {
    throw new Error(
      "This terminal link belongs to a tree that is not loaded in this window. Open its original VS Code window and copy a new link there.",
    );
  }

  if (workspaceModel.kind !== "configured") {
    throw new Error("This terminal link's tree is missing or invalid. Fix or restore its configuration first.");
  }

  const pendingTreeNodes = [...workspaceModel.resolvedTreeConfig.tree];

  while (pendingTreeNodes.length > 0) {
    const treeNode = pendingTreeNodes.shift();

    if (!treeNode) continue;

    if (treeNode.id === target.nodeId) {
      if (treeNode.kind !== "terminal") {
        throw new Error("This terminal link targets a group, not a terminal.");
      }

      return { kind: "node", workspaceModel, treeNode };
    }

    if (treeNode.kind === "group") pendingTreeNodes.unshift(...treeNode.children);
  }

  throw new Error("This terminal no longer exists in its tree. Copy a link from an existing terminal.");
}

function getRequiredQueryValue(query: URLSearchParams, name: string): string {
  const values = query.getAll(name);

  if (values.length !== 1 || !values[0]) {
    throw new Error(`The TreeTY terminal link requires exactly one ${name} value.`);
  }

  return values[0];
}

function validateTerminalLinkTarget(target: TerminalLinkTarget): void {
  let parsedConfigUri: URL;

  try {
    parsedConfigUri = new URL(target.configUri);
  } catch {
    throw new Error("The TreeTY terminal link has an invalid configuration URI.");
  }

  if (
    parsedConfigUri.protocol !== "file:" ||
    parsedConfigUri.search ||
    parsedConfigUri.hash ||
    !parsedConfigUri.pathname.startsWith("/")
  ) {
    throw new Error("Terminal links require a local configuration file URI.");
  }

  for (const value of [target.configUri, target.nodeId, target.sessionId]) {
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("The TreeTY terminal link contains an invalid target identity.");
    }
  }
}
