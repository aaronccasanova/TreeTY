import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileTransactionOptions<Document> {
  createDocument?: () => Document;
  lockRetryDelayMilliseconds?: number;
  lockStaleMilliseconds?: number;
  lockWaitMilliseconds?: number;
}

const defaultLockRetryDelayMilliseconds = 20;
const defaultLockStaleMilliseconds = 30_000;
const defaultLockWaitMilliseconds = 5_000;

export async function loadDocumentFile<Document>(
  documentFilePath: string,
  parseDocumentFileContent: (documentFileContent: string) => Document,
): Promise<Document> {
  const documentFileContent = await fs.readFile(documentFilePath, "utf8");

  return parseDocumentFileContent(documentFileContent);
}

export async function mutateDocumentFile<Document, Result = Document>(
  documentFilePath: string,
  parseDocumentFileContent: (documentFileContent: string) => Document,
  formatDocumentFileContent: (document: Document) => string,
  mutateDocument: (document: Document) => Document | Promise<Document>,
  getTransactionResult: (document: Document) => Result = (document) =>
    document as unknown as Result,
  options: FileTransactionOptions<Document> = {},
): Promise<Result> {
  await fs.mkdir(path.dirname(documentFilePath), { recursive: true });

  const lockFilePath = `${documentFilePath}.lock`;
  const lockFileHandle = await acquireFileLock(lockFilePath, options);

  try {
    const document = await loadLatestDocument(
      documentFilePath,
      parseDocumentFileContent,
      options.createDocument,
    );
    const originalDocumentFileContent = formatDocumentFileContent(document);
    const updatedDocument = await mutateDocument(document);
    const updatedDocumentFileContent =
      formatDocumentFileContent(updatedDocument);

    if (updatedDocumentFileContent !== originalDocumentFileContent) {
      await writeFileAtomically(documentFilePath, updatedDocumentFileContent);
    } else if (!(await getFileExists(documentFilePath))) {
      await writeFileAtomically(documentFilePath, updatedDocumentFileContent);
    }

    return getTransactionResult(updatedDocument);
  } finally {
    await releaseFileLock(lockFilePath, lockFileHandle);
  }
}

async function getFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);

    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;

    throw error;
  }
}

async function acquireFileLock<Document>(
  lockFilePath: string,
  options: FileTransactionOptions<Document>,
): Promise<fs.FileHandle> {
  const lockWaitMilliseconds =
    options.lockWaitMilliseconds ?? defaultLockWaitMilliseconds;
  const lockDeadline = Date.now() + lockWaitMilliseconds;

  while (true) {
    try {
      const lockFileHandle = await fs.open(lockFilePath, "wx");

      await lockFileHandle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        "utf8",
      );
      await lockFileHandle.sync();

      return lockFileHandle;
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") throw error;

      const recoveredAbandonedLock = await recoverAbandonedLock(
        lockFilePath,
        options.lockStaleMilliseconds ?? defaultLockStaleMilliseconds,
      );

      if (recoveredAbandonedLock) continue;

      if (Date.now() >= lockDeadline) {
        throw new Error(
          `Timed out waiting for TreeTY file lock ${lockFilePath}.`,
        );
      }

      await wait(
        options.lockRetryDelayMilliseconds ??
          defaultLockRetryDelayMilliseconds,
      );
    }
  }
}

async function recoverAbandonedLock(
  lockFilePath: string,
  lockStaleMilliseconds: number,
): Promise<boolean> {
  try {
    const lockFileStat = await fs.stat(lockFilePath);

    if (Date.now() - lockFileStat.mtimeMs <= lockStaleMilliseconds) {
      return false;
    }

    await fs.unlink(lockFilePath);

    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return true;

    throw error;
  }
}

async function releaseFileLock(
  lockFilePath: string,
  lockFileHandle: fs.FileHandle,
): Promise<void> {
  await lockFileHandle.close();

  try {
    await fs.unlink(lockFilePath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
}

async function loadLatestDocument<Document>(
  documentFilePath: string,
  parseDocumentFileContent: (documentFileContent: string) => Document,
  createDocument?: () => Document,
): Promise<Document> {
  try {
    return await loadDocumentFile(
      documentFilePath,
      parseDocumentFileContent,
    );
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" && createDocument) {
      return createDocument();
    }

    throw error;
  }
}

async function writeFileAtomically(
  documentFilePath: string,
  documentFileContent: string,
): Promise<void> {
  const documentFileDirPath = path.dirname(documentFilePath);
  const documentFileBaseName = path.basename(documentFilePath);
  const temporaryFilePath = path.join(
    documentFileDirPath,
    `.${documentFileBaseName}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let temporaryFileHandle: fs.FileHandle | undefined;

  try {
    temporaryFileHandle = await fs.open(temporaryFilePath, "wx");
    await temporaryFileHandle.writeFile(documentFileContent, "utf8");
    await temporaryFileHandle.sync();
    await temporaryFileHandle.close();
    temporaryFileHandle = undefined;

    await fs.rename(temporaryFilePath, documentFilePath);
  } catch (error) {
    await temporaryFileHandle?.close().catch(() => undefined);
    await fs.unlink(temporaryFilePath).catch(() => undefined);

    throw error;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getFileErrorCode(error: unknown): string | undefined {
  return getErrorCode(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}
