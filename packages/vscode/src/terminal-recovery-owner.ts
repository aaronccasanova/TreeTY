import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as net from "node:net";

export interface TerminalRecoveryOwnerIdentity {
  hostId: string;
  ownerId: string;
}

export type TerminalRecoveryOwnerLiveness = "alive" | "dead" | "unknown";

const ownerProbeMilliseconds = 1_000;
const ownerMessageMaximumBytes = 1_024;

export class TerminalRecoveryOwner {
  private ownerServer: net.Server | undefined;

  private ownerStartup: Promise<void> | undefined;

  private ownerShutdown: Promise<void> | undefined;

  private stopped = false;

  public constructor(private readonly identity: TerminalRecoveryOwnerIdentity) {}

  public async start(): Promise<void> {
    if (this.stopped) throw new Error("The terminal recovery owner has shut down.");

    const ownerStartup = this.ownerStartup ??= this.startOwnerServer();

    try {
      await ownerStartup;
    } catch (error) {
      if (this.ownerStartup === ownerStartup) this.ownerStartup = undefined;

      throw error;
    }

    if (this.stopped) throw new Error("The terminal recovery owner has shut down.");
  }

  public shutdown(): Promise<void> {
    this.stopped = true;

    return this.ownerShutdown ??= this.stopOwnerServer();
  }

  private async stopOwnerServer(): Promise<void> {
    await this.ownerStartup?.catch(() => {});

    if (!this.ownerServer?.listening) return;

    const ownerServer = this.ownerServer;

    await new Promise<void>((resolve, reject) => {
      ownerServer.close((error) => error ? reject(error) : resolve());
    });
  }

  private async startOwnerServer(): Promise<void> {
    const ownerEndpoint = buildTerminalRecoveryOwnerEndpoint(this.identity);
    const ownerServer = net.createServer((ownerSocket) => {
      let ownerMessage = "";
      const ownerTimeout = setTimeout(() => ownerSocket.destroy(), ownerProbeMilliseconds);

      ownerSocket.setEncoding("utf8");
      ownerSocket.once("close", () => clearTimeout(ownerTimeout));
      ownerSocket.on("error", () => {});
      ownerSocket.on("data", (chunk: string) => {
        ownerMessage += chunk;

        if (ownerMessage.length > ownerMessageMaximumBytes) {
          ownerSocket.destroy();

          return;
        }

        if (!ownerMessage.includes("\n")) return;

        try {
          const ownerRequest = JSON.parse(ownerMessage) as { ownerId?: unknown; challenge?: unknown };

          if (ownerRequest.ownerId !== this.identity.ownerId || typeof ownerRequest.challenge !== "string" ||
            !/^[A-Za-z0-9_-]{22}$/.test(ownerRequest.challenge)) {
            ownerSocket.destroy();

            return;
          }

          ownerSocket.end(`${JSON.stringify(ownerRequest)}\n`);
        } catch {
          ownerSocket.destroy();
        }
      });
    });

    this.ownerServer = ownerServer;
    await new Promise<void>((resolve, reject) => {
      ownerServer.once("error", reject);
      ownerServer.listen(ownerEndpoint, () => {
        ownerServer.off("error", reject);
        ownerServer.on("error", () => {});
        ownerServer.unref();
        resolve();
      });
    });

    if (process.platform === "win32") return;

    try {
      await fsPromises.chmod(ownerEndpoint, 0o600);
    } catch (error) {
      await new Promise<void>((resolve) => ownerServer.close(() => resolve()));

      throw error;
    }
  }
}

export function buildTerminalRecoveryOwnerEndpoint(identity: TerminalRecoveryOwnerIdentity): string {
  const ownerEndpointId = crypto.createHash("sha256")
    .update(JSON.stringify([identity.hostId, identity.ownerId])).digest("hex").slice(0, 48);

  if (process.platform === "win32") return `\\\\.\\pipe\\treety-owner-${ownerEndpointId}`;

  // A fixed short path avoids Unix socket truncation and differing or unusually long TMPDIR values.
  return `/tmp/treety-owner-${process.getuid?.() ?? "user"}-${ownerEndpointId}.sock`;
}

export async function getTerminalRecoveryOwnerLiveness(
  identity: TerminalRecoveryOwnerIdentity,
): Promise<TerminalRecoveryOwnerLiveness> {
  return await new Promise((resolve) => {
    const ownerSocket = net.createConnection(buildTerminalRecoveryOwnerEndpoint(identity));
    const challenge = crypto.randomBytes(16).toString("base64url");
    let ownerMessage = "";
    let settled = false;
    const probeTimeout = setTimeout(() => finishProbe("unknown"), ownerProbeMilliseconds);
    const finishProbe = (ownerLiveness: TerminalRecoveryOwnerLiveness): void => {
      if (settled) return;

      settled = true;
      clearTimeout(probeTimeout);
      ownerSocket.destroy();
      resolve(ownerLiveness);
    };

    ownerSocket.setEncoding("utf8");
    ownerSocket.on("connect", () => {
      ownerSocket.write(`${JSON.stringify({ ownerId: identity.ownerId, challenge })}\n`);
    });
    ownerSocket.on("error", (error: NodeJS.ErrnoException) => {
      finishProbe(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "dead" : "unknown");
    });
    ownerSocket.on("close", () => finishProbe("unknown"));
    ownerSocket.on("data", (chunk: string) => {
      ownerMessage += chunk;

      if (ownerMessage.length > ownerMessageMaximumBytes) {
        finishProbe("unknown");

        return;
      }

      if (!ownerMessage.includes("\n")) return;

      try {
        const ownerResponse = JSON.parse(ownerMessage) as { ownerId?: unknown; challenge?: unknown };

        finishProbe(ownerResponse.ownerId === identity.ownerId && ownerResponse.challenge === challenge
          ? "alive" : "unknown");
      } catch {
        finishProbe("unknown");
      }
    });
  });
}
