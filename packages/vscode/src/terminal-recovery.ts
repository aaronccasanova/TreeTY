import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { mutateDocumentFile } from "@treety/core";

import { getTerminalRecoveryOwnerLiveness, TerminalRecoveryOwner } from "./terminal-recovery-owner";
import type { TerminalRecoveryOwnerIdentity, TerminalRecoveryOwnerLiveness } from "./terminal-recovery-owner";

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
  ownerId?: string;
  ownerBindingId?: string;
  ownerProcessId?: number;
  ownerProtocol?: "ipc-v1";
  terminalProcessId?: number;
  retired?: boolean;
  closeReason?: "user" | "shutdown";
  persistence?: "disabled" | "reconnect" | "revive";
}

export interface TerminalRecoveryNodeScope {
  configFilePath: string;
  nodeId: string;
}

export type TerminalRecoveryRecordLiveness = "owned" | "other-window" | "running" | "unknown";

export type TerminalRecoveryRecordUpdate = Pick<
  TerminalRecoveryRecord,
  "ownerId" | "ownerBindingId" | "ownerProcessId" | "ownerProtocol" | "terminalProcessId" | "retired" | "closeReason" | "persistence"
>;

interface TerminalRecoveryRegistryOptions {
  getProcessIsAlive?: (processId: number) => boolean;
  getOwnerLiveness?: (identity: TerminalRecoveryOwnerIdentity) => Promise<TerminalRecoveryOwnerLiveness>;
  owner?: Pick<TerminalRecoveryOwner, "start" | "shutdown">;
  unavailableReason?: string;
}

export interface TerminalRecoveryStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
  keys(): readonly string[];
  refresh?(): Promise<void>;
  refreshRecord?(key: string): Promise<void>;
  replaceRecord?(key: string, terminalRecoveryRecord: TerminalRecoveryRecord): Promise<boolean>;
  runWithNodeLock?<Result>(nodeLockId: string, operation: () => Promise<Result>): Promise<Result>;
}

type TerminalRecoveryTarget = Pick<
  TerminalRecoveryRecord, "configFilePath" | "workspaceId" | "sessionId" | "nodeId" | "ownerBindingId"
>;
type TerminalRecoveryTreeScope = Omit<TerminalRecoveryScope, "hostId">;

const terminalRecoveryKeyPrefix = "treety.terminalRecovery.v1.";
// A negative lookahead requires the true end, unlike "$" before a final newline.
const terminalRecoveryTokenPattern = /^[A-Za-z0-9_-]{22}(?![\s\S])/;
const terminalRecoveryTitlePattern = / \[treety:([A-Za-z0-9_-]{22})\](?![\s\S])/;
const nodeOperationsByStorage = new WeakMap<TerminalRecoveryStorage, Map<string, Promise<void>>>();

export class TerminalRecoveryFileStorage implements TerminalRecoveryStorage {
  private storedRecordsByKey = new Map<string, unknown>();

  private recordFingerprintsByKey = new Map<string, string>();

  private storageOperation: Promise<void> = Promise.resolve();

  public constructor(private readonly recoveryDirPath: string) {
    if (!path.isAbsolute(recoveryDirPath)) {
      throw new Error("Terminal recovery storage requires an absolute directory path.");
    }
  }

  public get<T>(key: string): T | undefined {
    return this.storedRecordsByKey.get(key) as T | undefined;
  }

  public keys(): readonly string[] {
    return [...this.storedRecordsByKey.keys()];
  }

  public async refresh(): Promise<void> {
    await this.runStorageOperation(async () => {
      let recoveryEntries;

      try {
        recoveryEntries = await fs.readdir(this.recoveryDirPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

        this.storedRecordsByKey = new Map();
        this.recordFingerprintsByKey = new Map();

        return;
      }

      const storedRecordsByKey = new Map<string, unknown>();
      const recordFingerprintsByKey = new Map<string, string>();
      const recoveryEntryIterator = recoveryEntries.values();

      // Retained tokens can accumulate. Bound open files and reuse unchanged record contents.
      const refreshResults = await Promise.allSettled(Array.from({ length: 16 }, async () => {
        for (const recoveryEntry of recoveryEntryIterator) {
          if (!recoveryEntry.name.endsWith(".json")) continue;

          const token = recoveryEntry.name.slice(0, -".json".length);

          if (!terminalRecoveryTokenPattern.test(token)) continue;

          const key = `${terminalRecoveryKeyPrefix}${token}`;

          // Preserve occupied names without following symlinks or reading directories.
          if (!recoveryEntry.isFile()) {
            storedRecordsByKey.set(key, undefined);

            continue;
          }

          try {
            const recoveryFilePath = path.join(this.recoveryDirPath, recoveryEntry.name);
            const recoveryFileStat = await fs.lstat(recoveryFilePath, { bigint: true });

            if (!recoveryFileStat.isFile()) {
              storedRecordsByKey.set(key, undefined);

              continue;
            }

            const recordFingerprint = [
              recoveryFileStat.dev, recoveryFileStat.ino, recoveryFileStat.size,
              recoveryFileStat.mtimeNs, recoveryFileStat.ctimeNs,
            ].join(":");

            recordFingerprintsByKey.set(key, recordFingerprint);

            if (this.recordFingerprintsByKey.get(key) === recordFingerprint) {
              storedRecordsByKey.set(key, this.storedRecordsByKey.get(key));

              continue;
            }

            const recoveryFileContent = await fs.readFile(recoveryFilePath, "utf8");

            try {
              storedRecordsByKey.set(key, JSON.parse(recoveryFileContent));
            } catch {
              // Invalid JSON still occupies its token and must never be overwritten.
              storedRecordsByKey.set(key, undefined);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

            recordFingerprintsByKey.delete(key);
          }
        }
      }));

      const refreshErrors = refreshResults.flatMap((refreshResult) =>
        refreshResult.status === "rejected" ? [refreshResult.reason] : [],
      );

      if (refreshErrors.length > 0) throw new AggregateError(refreshErrors, "Could not refresh terminal recovery records.");

      this.storedRecordsByKey = storedRecordsByKey;
      this.recordFingerprintsByKey = recordFingerprintsByKey;
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
      this.recordFingerprintsByKey.delete(key);

      if (value === undefined) {
        try {
          await fs.unlink(recoveryFilePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        this.storedRecordsByKey.delete(key);

        return;
      }

      await fs.mkdir(this.recoveryDirPath, { recursive: true, mode: 0o700 });
      await fs.writeFile(recoveryFilePath, JSON.stringify(value), {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      this.storedRecordsByKey.set(key, value);
    });
  }

  public async refreshRecord(key: string): Promise<void> {
    const recoveryFilePath = this.getRecoveryFilePath(key);

    await this.runStorageOperation(async () => {
      this.recordFingerprintsByKey.delete(key);

      try {
        const recoveryFileStat = await fs.lstat(recoveryFilePath);

        if (!recoveryFileStat.isFile()) {
          this.storedRecordsByKey.set(key, undefined);

          return;
        }

        const recoveryFileContent = await fs.readFile(recoveryFilePath, "utf8");

        try {
          this.storedRecordsByKey.set(key, JSON.parse(recoveryFileContent));
        } catch {
          this.storedRecordsByKey.set(key, undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

        this.storedRecordsByKey.delete(key);
      }
    });
  }

  public async replaceRecord(
    key: string,
    terminalRecoveryRecord: TerminalRecoveryRecord,
  ): Promise<boolean> {
    const recoveryFilePath = this.getRecoveryFilePath(key);
    let didReplaceRecord = false;

    await this.runStorageOperation(async () => {
      this.recordFingerprintsByKey.delete(key);

      try {
        const recoveryFileStat = await fs.lstat(recoveryFilePath);

        if (!recoveryFileStat.isFile()) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

        this.storedRecordsByKey.delete(key);

        return;
      }

      const temporaryFilePath = `${recoveryFilePath}.${crypto.randomUUID()}.tmp`;

      try {
        await fs.writeFile(temporaryFilePath, JSON.stringify(terminalRecoveryRecord), {
          encoding: "utf8", flag: "wx", mode: 0o600,
        });
        await fs.rename(temporaryFilePath, recoveryFilePath);
      } finally {
        await fs.unlink(temporaryFilePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }

      this.storedRecordsByKey.set(key, terminalRecoveryRecord);
      didReplaceRecord = true;
    });

    return didReplaceRecord;
  }

  public async runWithNodeLock<Result>(
    nodeLockId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const nodeLockFileName = crypto.createHash("sha256").update(nodeLockId).digest("hex");
    const nodeLockFilePath = path.join(this.recoveryDirPath, "node-locks", `${nodeLockFileName}.json`);
    let operationResult: Result;

    await mutateDocumentFile(
      nodeLockFilePath,
      JSON.parse,
      JSON.stringify,
      async (lockDocument) => {
        operationResult = await operation();

        return lockDocument;
      },
      undefined,
      { createDocument: () => ({ version: 1 }), preserveLiveLocks: true },
    );

    return operationResult!;
  }

  private getRecoveryFilePath(key: string): string {
    const token = key.startsWith(terminalRecoveryKeyPrefix)
      ? key.slice(terminalRecoveryKeyPrefix.length)
      : "";

    if (!terminalRecoveryTokenPattern.test(token)) {
      throw new Error("The terminal recovery storage key is invalid.");
    }

    return path.join(this.recoveryDirPath, `${token}.json`);
  }

  private runStorageOperation(operation: () => Promise<void>): Promise<void> {
    const storageOperation = this.storageOperation.then(operation);

    // Keep later operations usable after an individual filesystem failure.
    this.storageOperation = storageOperation.catch(() => {});

    return storageOperation;
  }
}

export class TerminalRecoveryRegistry {
  public readonly ownerId = crypto.randomUUID();

  public readonly ownerProcessId = process.pid;

  public readonly unavailableReason: string | undefined;

  public readonly isAvailable: boolean;

  private registryRefresh: Promise<void> | undefined;

  private lastRefreshAt = Number.NEGATIVE_INFINITY;

  private readonly owner: Pick<TerminalRecoveryOwner, "start" | "shutdown">;

  private stopped = false;

  private readonly ownerLivenessById = new Map<string, TerminalRecoveryOwnerLiveness>();

  private readonly ownerProbesById = new Map<string, Promise<void>>();

  public constructor(
    private readonly storage: TerminalRecoveryStorage,
    private readonly hostId: string,
    private readonly options: TerminalRecoveryRegistryOptions = {},
  ) {
    if (!getIsRecoveryField(hostId)) {
      throw new Error("Terminal recovery requires a host identity.");
    }

    this.unavailableReason = options.unavailableReason;
    this.isAvailable = options.unavailableReason === undefined;
    this.owner = options.owner ?? new TerminalRecoveryOwner({ hostId, ownerId: this.ownerId });
  }

  public static createUnavailable(hostId: string, message: string): TerminalRecoveryRegistry {
    return new TerminalRecoveryRegistry({
      get: () => undefined,
      keys: () => [],
      update: async () => { throw new Error(message); },
    }, hostId, { unavailableReason: message });
  }

  public async refresh(force = false): Promise<void> {
    if (this.registryRefresh) {
      await this.registryRefresh;

      if (!force) return;
    }

    if (!force && Date.now() - this.lastRefreshAt < 1_000) return;

    const registryRefresh = (async () => {
      await this.storage.refresh?.();
      await this.refreshOwners();
      this.lastRefreshAt = Date.now();
    })();

    this.registryRefresh = registryRefresh;

    try {
      await registryRefresh;
    } finally {
      if (this.registryRefresh === registryRefresh) this.registryRefresh = undefined;
    }
  }

  public async refreshRecord(token: string): Promise<void> {
    if (!terminalRecoveryTokenPattern.test(token)) return;

    if (this.storage.refreshRecord) {
      await this.storage.refreshRecord(`${terminalRecoveryKeyPrefix}${token}`);
      await this.refreshOwner(this.getRecord(token));

      return;
    }

    await this.refresh(true);
  }

  public async shutdown(): Promise<void> {
    this.stopped = true;
    await this.owner.shutdown();
  }

  public async runWithNodeLock<Result>(
    terminalRecoveryNodeScope: TerminalRecoveryNodeScope,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.assertAvailable();

    const nodeLockId = JSON.stringify([this.hostId, terminalRecoveryNodeScope.configFilePath, terminalRecoveryNodeScope.nodeId]);

    if (this.storage.runWithNodeLock) {
      return await this.storage.runWithNodeLock(nodeLockId, operation);
    }

    let nodeOperations = nodeOperationsByStorage.get(this.storage);

    if (!nodeOperations) {
      nodeOperations = new Map();
      nodeOperationsByStorage.set(this.storage, nodeOperations);
    }

    const previousNodeOperation = nodeOperations.get(nodeLockId) ?? Promise.resolve();
    const nodeOperation = previousNodeOperation.then(operation);
    const nodeOperationCompletion = nodeOperation.then(() => {}, () => {});

    nodeOperations.set(nodeLockId, nodeOperationCompletion);

    try {
      return await nodeOperation;
    } finally {
      if (nodeOperations.get(nodeLockId) === nodeOperationCompletion) nodeOperations.delete(nodeLockId);
    }
  }

  public async createRecord(
    terminalRecoveryTarget: TerminalRecoveryTarget,
  ): Promise<TerminalRecoveryRecord> {
    this.assertAvailable();

    const ownerProtocol = await this.startOwnerProtocol();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = crypto.randomBytes(16).toString("base64url");
      const terminalRecoveryRecord: TerminalRecoveryRecord = {
        ...terminalRecoveryTarget,
        version: 1,
        token,
        hostId: this.hostId,
        ownerId: this.ownerId,
        ownerProcessId: this.ownerProcessId,
        ...(ownerProtocol ? { ownerProtocol } : {}),
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

  public getRecordsForNode(
    terminalRecoveryNodeScope: TerminalRecoveryNodeScope,
  ): TerminalRecoveryRecord[] {
    const terminalRecoveryRecords: TerminalRecoveryRecord[] = [];

    for (const recoveryKey of this.storage.keys()) {
      if (!recoveryKey.startsWith(terminalRecoveryKeyPrefix)) continue;

      const terminalRecoveryRecord = this.getRecord(recoveryKey.slice(terminalRecoveryKeyPrefix.length));

      if (terminalRecoveryRecord?.configFilePath === terminalRecoveryNodeScope.configFilePath &&
        terminalRecoveryRecord.nodeId === terminalRecoveryNodeScope.nodeId) {
        terminalRecoveryRecords.push(terminalRecoveryRecord);
      }
    }

    return terminalRecoveryRecords;
  }

  public getRecordLiveness(terminalRecoveryRecord: TerminalRecoveryRecord): TerminalRecoveryRecordLiveness {
    if (terminalRecoveryRecord.ownerId === this.ownerId) return "owned";

    const getProcessIsAlive = this.options.getProcessIsAlive ?? getProcessIsAliveOnHost;

    if (terminalRecoveryRecord.ownerProcessId && getProcessIsAlive(terminalRecoveryRecord.ownerProcessId) &&
      (terminalRecoveryRecord.ownerProtocol !== "ipc-v1" || !terminalRecoveryRecord.ownerId ||
        this.ownerLivenessById.get(terminalRecoveryRecord.ownerId) !== "dead")) {
      return "other-window";
    }

    if (terminalRecoveryRecord.retired) return "unknown";

    if (terminalRecoveryRecord.terminalProcessId && getProcessIsAlive(terminalRecoveryRecord.terminalProcessId)) {
      return "running";
    }

    return "unknown";
  }

  // The caller must hold this node's lock while retiring records and reserving a replacement.
  public async retireClosedRecordsForNode(
    terminalRecoveryNodeScope: TerminalRecoveryNodeScope,
  ): Promise<TerminalRecoveryRecord[]> {
    this.assertAvailable();

    const retiredTerminalRecoveryRecords: TerminalRecoveryRecord[] = [];
    const getProcessIsAlive = this.options.getProcessIsAlive ?? getProcessIsAliveOnHost;

    for (const terminalRecoveryRecord of this.getRecordsForNode(terminalRecoveryNodeScope)) {
      if (terminalRecoveryRecord.retired) continue;

      await this.refreshRecord(terminalRecoveryRecord.token);

      const currentTerminalRecoveryRecord = this.getRecord(terminalRecoveryRecord.token);

      if (!currentTerminalRecoveryRecord || currentTerminalRecoveryRecord.retired ||
        currentTerminalRecoveryRecord.configFilePath !== terminalRecoveryNodeScope.configFilePath ||
        currentTerminalRecoveryRecord.nodeId !== terminalRecoveryNodeScope.nodeId) continue;

      const recordLiveness = this.getRecordLiveness(currentTerminalRecoveryRecord);

      if (recordLiveness === "owned" || recordLiveness === "other-window") continue;

      const isPersistenceDisabledShutdown = currentTerminalRecoveryRecord.closeReason === "shutdown" &&
        currentTerminalRecoveryRecord.persistence === "disabled";
      const hasClosedTerminalProcess = currentTerminalRecoveryRecord.terminalProcessId !== undefined &&
        !getProcessIsAlive(currentTerminalRecoveryRecord.terminalProcessId);
      const canRetireClosedTerminalProcess = hasClosedTerminalProcess &&
        currentTerminalRecoveryRecord.closeReason === "shutdown" && currentTerminalRecoveryRecord.persistence === "reconnect";

      if (!isPersistenceDisabledShutdown && !canRetireClosedTerminalProcess) continue;

      const retiredTerminalRecoveryRecord = await this.updateRecord(currentTerminalRecoveryRecord.token, { retired: true });

      if (retiredTerminalRecoveryRecord) retiredTerminalRecoveryRecords.push(retiredTerminalRecoveryRecord);
    }

    return retiredTerminalRecoveryRecords;
  }

  public async updateRecord(
    token: string,
    terminalRecoveryRecordUpdate: TerminalRecoveryRecordUpdate,
  ): Promise<TerminalRecoveryRecord | undefined> {
    this.assertAvailable();
    await this.refreshRecord(token);

    const terminalRecoveryRecord = this.getRecord(token);

    if (!terminalRecoveryRecord) return undefined;

    const updatedTerminalRecoveryRecord = { ...terminalRecoveryRecord };

    for (const field of ["ownerId", "ownerBindingId", "ownerProcessId", "ownerProtocol", "terminalProcessId", "retired", "closeReason", "persistence"] as const) {
      if (!Object.hasOwn(terminalRecoveryRecordUpdate, field)) continue;

      if (terminalRecoveryRecordUpdate[field] === undefined) {
        delete updatedTerminalRecoveryRecord[field];

        continue;
      }

      Object.assign(updatedTerminalRecoveryRecord, { [field]: terminalRecoveryRecordUpdate[field] });
    }

    if (terminalRecoveryRecordUpdate.retired === true) {
      delete updatedTerminalRecoveryRecord.ownerId;
      delete updatedTerminalRecoveryRecord.ownerBindingId;
      delete updatedTerminalRecoveryRecord.ownerProcessId;
      delete updatedTerminalRecoveryRecord.terminalProcessId;
    }

    if (!updatedTerminalRecoveryRecord.ownerId) {
      delete updatedTerminalRecoveryRecord.ownerProtocol;
    } else if (updatedTerminalRecoveryRecord.ownerId === this.ownerId) {
      const ownerProtocol = await this.startOwnerProtocol();

      if (ownerProtocol) {
        updatedTerminalRecoveryRecord.ownerProtocol = ownerProtocol;
      } else {
        delete updatedTerminalRecoveryRecord.ownerProtocol;
      }
    } else if (Object.hasOwn(terminalRecoveryRecordUpdate, "ownerId") &&
      !Object.hasOwn(terminalRecoveryRecordUpdate, "ownerProtocol")) {
      delete updatedTerminalRecoveryRecord.ownerProtocol;
    }

    if (!getIsRecoveryRecord(updatedTerminalRecoveryRecord)) {
      throw new Error("The terminal recovery record update is invalid.");
    }

    const recoveryKey = `${terminalRecoveryKeyPrefix}${token}`;

    if (this.storage.replaceRecord) {
      return await this.storage.replaceRecord(recoveryKey, updatedTerminalRecoveryRecord)
        ? updatedTerminalRecoveryRecord
        : undefined;
    }

    await this.storage.update(recoveryKey, updatedTerminalRecoveryRecord);

    return updatedTerminalRecoveryRecord;
  }

  public async removeRecord(
    token: string,
    expectedOwner?: { ownerId: string; ownerBindingId: string },
    beforeRemove?: () => Promise<void>,
  ): Promise<void> {
    await this.refreshRecord(token);

    const terminalRecoveryRecord = this.getRecord(token);

    if (!terminalRecoveryRecord) {
      await beforeRemove?.();

      return;
    }

    await this.runWithNodeLock(terminalRecoveryRecord, async () => {
      await this.refreshRecord(token);

      const currentTerminalRecoveryRecord = this.getRecord(token);

      if (!currentTerminalRecoveryRecord) {
        await beforeRemove?.();

        return;
      }

      if (currentTerminalRecoveryRecord.configFilePath !== terminalRecoveryRecord.configFilePath ||
        currentTerminalRecoveryRecord.nodeId !== terminalRecoveryRecord.nodeId ||
        currentTerminalRecoveryRecord.sessionId !== terminalRecoveryRecord.sessionId) return;

      if (expectedOwner && (
        currentTerminalRecoveryRecord.ownerId !== expectedOwner.ownerId ||
        currentTerminalRecoveryRecord.ownerBindingId !== expectedOwner.ownerBindingId
      )) return;

      const cleanupResults = await Promise.allSettled([
        Promise.resolve().then(() => beforeRemove?.()),
        this.storage.update(`${terminalRecoveryKeyPrefix}${token}`, undefined),
      ]);
      const cleanupErrors = cleanupResults.flatMap((cleanupResult) =>
        cleanupResult.status === "rejected" ? [cleanupResult.reason] : [],
      );

      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Could not finish terminal recovery cleanup.");
      }
    });
  }

  private assertAvailable(): void {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
  }

  private async startOwnerProtocol(): Promise<TerminalRecoveryRecord["ownerProtocol"]> {
    if (this.stopped) throw new Error("The terminal recovery owner has shut down.");

    let ownerProtocol: TerminalRecoveryRecord["ownerProtocol"];

    try {
      await this.owner.start();
      ownerProtocol = "ipc-v1";
    } catch {
      // PID ownership remains conservative when local IPC is unavailable.
    }

    if (this.stopped) throw new Error("The terminal recovery owner has shut down.");

    return ownerProtocol;
  }

  private async refreshOwners(): Promise<void> {
    const recordsByOwnerId = new Map<string, TerminalRecoveryRecord>();

    for (const recoveryKey of this.storage.keys()) {
      if (!recoveryKey.startsWith(terminalRecoveryKeyPrefix)) continue;

      const terminalRecoveryRecord = this.getRecord(recoveryKey.slice(terminalRecoveryKeyPrefix.length));

      if (terminalRecoveryRecord?.ownerId && terminalRecoveryRecord.ownerProtocol === "ipc-v1") {
        recordsByOwnerId.set(terminalRecoveryRecord.ownerId, terminalRecoveryRecord);
      }
    }

    const ownerRecords = recordsByOwnerId.values();

    await Promise.all(Array.from({ length: Math.min(16, recordsByOwnerId.size) }, async () => {
      for (const terminalRecoveryRecord of ownerRecords) {
        await this.refreshOwner(terminalRecoveryRecord);
      }
    }));
  }

  private async refreshOwner(terminalRecoveryRecord: TerminalRecoveryRecord | undefined): Promise<void> {
    if (!terminalRecoveryRecord?.ownerId || terminalRecoveryRecord.ownerId === this.ownerId ||
      terminalRecoveryRecord.ownerProtocol !== "ipc-v1") return;

    const ownerId = terminalRecoveryRecord.ownerId;
    const currentOwnerProbe = this.ownerProbesById.get(ownerId);

    if (currentOwnerProbe) return await currentOwnerProbe;

    const ownerProbe = (async () => {
      const getOwnerLiveness = this.options.getOwnerLiveness ?? getTerminalRecoveryOwnerLiveness;
      const ownerLiveness = await getOwnerLiveness({ hostId: this.hostId, ownerId }).catch(() => "unknown" as const);

      this.ownerLivenessById.set(ownerId, ownerLiveness);
    })();

    this.ownerProbesById.set(ownerId, ownerProbe);

    try {
      await ownerProbe;
    } finally {
      if (this.ownerProbesById.get(ownerId) === ownerProbe) this.ownerProbesById.delete(ownerId);
    }
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
    getIsRecoveryField(terminalRecoveryRecord.nodeId) &&
    (terminalRecoveryRecord.ownerId === undefined || getIsRecoveryField(terminalRecoveryRecord.ownerId)) &&
    (terminalRecoveryRecord.ownerBindingId === undefined || getIsRecoveryField(terminalRecoveryRecord.ownerBindingId)) &&
    (terminalRecoveryRecord.ownerProcessId === undefined || getIsProcessId(terminalRecoveryRecord.ownerProcessId)) &&
    (terminalRecoveryRecord.ownerProtocol === undefined || terminalRecoveryRecord.ownerProtocol === "ipc-v1") &&
    (terminalRecoveryRecord.terminalProcessId === undefined || getIsProcessId(terminalRecoveryRecord.terminalProcessId)) &&
    (terminalRecoveryRecord.retired === undefined || typeof terminalRecoveryRecord.retired === "boolean") &&
    (terminalRecoveryRecord.closeReason === undefined || terminalRecoveryRecord.closeReason === "user" || terminalRecoveryRecord.closeReason === "shutdown") &&
    (terminalRecoveryRecord.persistence === undefined || terminalRecoveryRecord.persistence === "disabled" ||
      terminalRecoveryRecord.persistence === "reconnect" || terminalRecoveryRecord.persistence === "revive");
}

function getIsRecoveryField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function getIsProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function getProcessIsAliveOnHost(processId: number): boolean {
  try {
    process.kill(processId, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
