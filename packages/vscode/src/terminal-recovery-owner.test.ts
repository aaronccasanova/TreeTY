import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as nodeTest from "node:test";

import {
  buildTerminalRecoveryOwnerEndpoint,
  getTerminalRecoveryOwnerLiveness,
  TerminalRecoveryOwner,
} from "./terminal-recovery-owner";

nodeTest.test("owner proof recognizes its exact instance and disappears after shutdown", async (testContext) => {
  const identity = { hostId: "host", ownerId: crypto.randomUUID() };
  const owner = new TerminalRecoveryOwner(identity);

  testContext.after(() => owner.shutdown());
  assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "dead");
  await owner.start();
  assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "alive");

  if (process.platform !== "win32") {
    const ownerSocketStat = await fs.stat(buildTerminalRecoveryOwnerEndpoint(identity));

    assert.equal(ownerSocketStat.mode & 0o777, 0o600);
  }

  await Promise.all([owner.shutdown(), owner.shutdown()]);
  assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "dead");
  await assert.rejects(owner.start(), /shut down/);
});

nodeTest.test("another owner cannot replace or remove an occupied endpoint", async (testContext) => {
  const identity = { hostId: "host", ownerId: crypto.randomUUID() };
  const owner = new TerminalRecoveryOwner(identity);
  const duplicateOwner = new TerminalRecoveryOwner(identity);

  testContext.after(() => Promise.all([owner.shutdown(), duplicateOwner.shutdown()]));
  await owner.start();
  await assert.rejects(duplicateOwner.start(), { code: "EADDRINUSE" });
  assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "alive");
});

nodeTest.test("a crashed owner leaves no live proof even when its Unix socket remains", async (testContext) => {
  const identity = { hostId: "host", ownerId: crypto.randomUUID() };
  const ownerEndpoint = buildTerminalRecoveryOwnerEndpoint(identity);
  const ownerProcess = childProcess.spawn(process.execPath, ["-e", `
    const net = require("node:net");
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (message) => socket.end(message));
    });
    server.listen(process.argv[1], () => process.stdout.write("ready"));
  `, ownerEndpoint], { stdio: ["ignore", "pipe", "pipe"] });

  testContext.after(async () => {
    ownerProcess.kill();

    if (process.platform !== "win32") {
      await fs.unlink(ownerEndpoint).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ownerProcess.once("error", reject);
    ownerProcess.once("exit", () => reject(new Error("Owner exited before opening its endpoint.")));
    ownerProcess.stdout.once("data", () => resolve());
  });
  assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "alive");

  const ownerExit = new Promise<void>((resolve) => ownerProcess.once("exit", () => resolve()));

  ownerProcess.kill("SIGKILL");
  await ownerExit;
  assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "dead");

  if (process.platform !== "win32") assert.equal((await fs.stat(ownerEndpoint)).isSocket(), true);
});

nodeTest.test("owner proof is conservative for silent and incorrect challenge responses", async (testContext) => {
  for (const response of [undefined, JSON.stringify({ ownerId: "unrelated", challenge: "unrelated" })]) {
    const identity = { hostId: "host", ownerId: crypto.randomUUID() };
    const sockets = new Set<net.Socket>();
    const ownerServer = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));

      if (response) socket.end(`${response}\n`);
    });

    testContext.after(async () => {
      for (const socket of sockets) socket.destroy();

      await new Promise<void>((resolve) => ownerServer.close(() => resolve()));
    });
    await new Promise<void>((resolve) => ownerServer.listen(buildTerminalRecoveryOwnerEndpoint(identity), resolve));
    assert.equal(await getTerminalRecoveryOwnerLiveness(identity), "unknown");
  }
});

nodeTest.test("owner endpoint names stay short and separate hosts and owners regardless of TMPDIR", () => {
  const identity = { hostId: "h".repeat(1_000), ownerId: crypto.randomUUID() };
  const ownerEndpoint = buildTerminalRecoveryOwnerEndpoint(identity);

  assert.ok(Buffer.byteLength(ownerEndpoint) < 100);
  assert.notEqual(buildTerminalRecoveryOwnerEndpoint({ ...identity, hostId: "other" }), ownerEndpoint);
  assert.notEqual(buildTerminalRecoveryOwnerEndpoint({ ...identity, ownerId: crypto.randomUUID() }), ownerEndpoint);
  assert.match(ownerEndpoint, process.platform === "win32" ? /^\\\\\.\\pipe\\/ : /^\/tmp\/treety-owner-/);
});
