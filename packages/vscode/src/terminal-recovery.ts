import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TerminalRecoveryScope {
  configFilePath: string;
  workspaceId: string;
  hostId: string;
}

export interface TerminalRecoveryRecord extends TerminalRecoveryScope {
  version: 1;
  token: string;
  sessionId: string;
  nodeId: string;
}

export interface TerminalRecoveryStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
  keys(): readonly string[];
  refresh?(): Promise<void>;
}

type TerminalRecoveryTarget = Omit<TerminalRecoveryRecord, "version" | "token" | "hostId">;
type TerminalRecoveryTreeScope = Omit<TerminalRecoveryScope, "hostId">;

const terminalRecoveryKeyPrefix = "treety.terminalRecovery.v1.";
// A negative lookahead requires the true end, unlike "$" before a final newline.
const terminalRecoveryTokenPattern = /^[A-Za-z0-9_-]{22}(?![\s\S])/;
const terminalRecoveryTitlePattern = / \[treety:([A-Za-z0-9_-]{22})\](?![\s\S])/;

export class TerminalRecoveryFileStorage implements TerminalRecoveryStorage {
  private values = new Map<string, unknown>();

  private storageOperation: Promise<void> = Promise.resolve();

  public constructor(private readonly recoveryDirPath: string) {
    if (!path.isAbsolute(recoveryDirPath)) {
      throw new Error("Terminal recovery storage requires an absolute directory path.");
    }
  }

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public async refresh(): Promise<void> {
    await this.runStorageOperation(async () => {
      let recoveryEntries;

      try {
        recoveryEntries = await fs.readdir(this.recoveryDirPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

        this.values = new Map();

        return;
      }

      const values = new Map<string, unknown>();

      await Promise.all(recoveryEntries.map(async (recoveryEntry) => {
        if (!recoveryEntry.name.endsWith(".json")) return;

        const token = recoveryEntry.name.slice(0, -".json".length);

        if (!terminalRecoveryTokenPattern.test(token)) return;

        const key = `${terminalRecoveryKeyPrefix}${token}`;

        // Preserve occupied names without following symlinks or reading directories.
        if (!recoveryEntry.isFile()) {
          values.set(key, undefined);

          return;
        }

        let recoveryFileContent: string;

        try {
          recoveryFileContent = await fs.readFile(
            path.join(this.recoveryDirPath, recoveryEntry.name), "utf8",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

          return;
        }

        try {
          values.set(key, JSON.parse(recoveryFileContent));
        } catch {
          // Invalid JSON still occupies its token and must never be overwritten.
          values.set(key, undefined);
        }
      }));

      this.values = values;
    });
  }

  public async update(key: string, value: unknown): Promise<void> {
    const token = key.startsWith(terminalRecoveryKeyPrefix)
      ? key.slice(terminalRecoveryKeyPrefix.length)
      : "";

    if (!terminalRecoveryTokenPattern.test(token)) {
      throw new Error("The terminal recovery storage key is invalid.");
    }

    const recoveryFilePath = path.join(this.recoveryDirPath, `${token}.json`);

    await this.runStorageOperation(async () => {
      if (value === undefined) {
        try {
          await fs.unlink(recoveryFilePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        this.values.delete(key);

        return;
      }

      await fs.mkdir(this.recoveryDirPath, { recursive: true, mode: 0o700 });
      await fs.writeFile(recoveryFilePath, JSON.stringify(value), {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      this.values.set(key, value);
    });
  }

  private runStorageOperation(operation: () => Promise<void>): Promise<void> {
    const storageOperation = this.storageOperation.then(operation);

    // Keep later operations usable after an individual filesystem failure.
    this.storageOperation = storageOperation.catch(() => {});

    return storageOperation;
  }
}

export class TerminalRecoveryRegistry {
  public constructor(
    private readonly storage: TerminalRecoveryStorage,
    private readonly hostId: string,
  ) {
    if (!getIsRecoveryField(hostId)) {
      throw new Error("Terminal recovery requires a host identity.");
    }
  }

  public async refresh(): Promise<void> {
    await this.storage.refresh?.();
  }

  public async createRecord(
    terminalRecoveryTarget: TerminalRecoveryTarget,
  ): Promise<TerminalRecoveryRecord> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = crypto.randomBytes(16).toString("base64url");
      const terminalRecoveryRecord: TerminalRecoveryRecord = {
        ...terminalRecoveryTarget,
        version: 1,
        token,
        hostId: this.hostId,
      };

      if (!getIsRecoveryRecord(terminalRecoveryRecord)) {
        throw new Error("Terminal recovery requires a valid tree and session identity.");
      }

      const terminalRecoveryKey = `${terminalRecoveryKeyPrefix}${token}`;

      if (
        this.storage.get<unknown>(terminalRecoveryKey) !== undefined ||
        this.storage.keys().includes(terminalRecoveryKey)
      ) {
        continue;
      }

      try {
        await this.storage.update(terminalRecoveryKey, terminalRecoveryRecord);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;

        throw error;
      }

      return terminalRecoveryRecord;
    }

    throw new Error("Could not allocate a unique terminal recovery token.");
  }

  public getRecord(token: string): TerminalRecoveryRecord | undefined {
    if (!terminalRecoveryTokenPattern.test(token)) return undefined;

    const terminalRecoveryRecord = this.storage.get<unknown>(
      `${terminalRecoveryKeyPrefix}${token}`,
    );

    if (
      !getIsRecoveryRecord(terminalRecoveryRecord) ||
      terminalRecoveryRecord.token !== token ||
      terminalRecoveryRecord.hostId !== this.hostId
    ) {
      return undefined;
    }

    return { ...terminalRecoveryRecord };
  }

  public getRecords(
    terminalRecoveryTreeScope: TerminalRecoveryTreeScope,
  ): TerminalRecoveryRecord[] {
    const terminalRecoveryRecords: TerminalRecoveryRecord[] = [];

    for (const terminalRecoveryKey of this.storage.keys()) {
      if (!terminalRecoveryKey.startsWith(terminalRecoveryKeyPrefix)) continue;

      const terminalRecoveryRecord = this.getRecord(
        terminalRecoveryKey.slice(terminalRecoveryKeyPrefix.length),
      );

      if (
        !terminalRecoveryRecord ||
        terminalRecoveryRecord.configFilePath !== terminalRecoveryTreeScope.configFilePath ||
        terminalRecoveryRecord.workspaceId !== terminalRecoveryTreeScope.workspaceId
      ) {
        continue;
      }

      terminalRecoveryRecords.push(terminalRecoveryRecord);
    }

    return terminalRecoveryRecords;
  }

  public async removeRecord(token: string): Promise<void> {
    if (!this.getRecord(token)) return;

    await this.storage.update(`${terminalRecoveryKeyPrefix}${token}`, undefined);
  }
}

export function buildTerminalTitle(name: string, token: string): string {
  if (!terminalRecoveryTokenPattern.test(token)) {
    throw new Error("The terminal recovery token is invalid.");
  }

  return `TreeTY: ${name} [treety:${token}]`;
}

export function getTerminalRecoveryToken(name: string): string | undefined {
  return terminalRecoveryTitlePattern.exec(name)?.[1];
}

function getIsRecoveryRecord(value: unknown): value is TerminalRecoveryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const terminalRecoveryRecord = value as Record<string, unknown>;

  return terminalRecoveryRecord.version === 1 &&
    typeof terminalRecoveryRecord.token === "string" &&
    terminalRecoveryTokenPattern.test(terminalRecoveryRecord.token) &&
    getIsRecoveryField(terminalRecoveryRecord.configFilePath) &&
    getIsRecoveryField(terminalRecoveryRecord.workspaceId) &&
    getIsRecoveryField(terminalRecoveryRecord.hostId) &&
    getIsRecoveryField(terminalRecoveryRecord.sessionId) &&
    getIsRecoveryField(terminalRecoveryRecord.nodeId);
}

function getIsRecoveryField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
