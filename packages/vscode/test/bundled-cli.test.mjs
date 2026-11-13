import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

const testFilePath = url.fileURLToPath(import.meta.url);
const extensionDirPath = path.resolve(path.dirname(testFilePath), "..");
const projectRootDirPath = path.resolve(extensionDirPath, "../..");
const cliPackageConfig = JSON.parse(
  fs.readFileSync(
    path.join(projectRootDirPath, "packages", "cli", "package.json"),
    "utf8",
  ),
);

nodeTest.test("bundled CLI runs outside the repository without installed packages", () => {
  const temporaryDirPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "treety bundled cli "),
  );

  try {
    const extensionDistDirPath = path.join(temporaryDirPath, "extension", "dist");
    const extensionBinDirPath = path.join(temporaryDirPath, "extension", "bin");
    const cliFilePath = path.join(extensionDistDirPath, "cli.js");
    const workspaceDirPath = path.join(temporaryDirPath, "workspace with spaces");
    const environment = { ...process.env };

    delete environment.NODE_PATH;
    delete environment.NODE_OPTIONS;
    delete environment.TREETY_CONFIG_FILE;

    fs.mkdirSync(extensionDistDirPath, { recursive: true });
    fs.mkdirSync(workspaceDirPath, { recursive: true });
    fs.copyFileSync(path.join(extensionDirPath, "dist", "cli.js"), cliFilePath);
    fs.cpSync(path.join(extensionDirPath, "bin"), extensionBinDirPath, {
      recursive: true,
    });

    const versionResult = childProcess.spawnSync(
      process.execPath,
      [cliFilePath, "--version"],
      {
        cwd: workspaceDirPath,
        encoding: "utf8",
        env: environment,
      },
    );

    assert.equal(versionResult.status, 0, versionResult.stderr);
    assert.equal(versionResult.stdout.trim(), cliPackageConfig.version);

    const configFilePath = path.join(workspaceDirPath, "custom tree.json");
    const initializeResult = runBundledCli({
      cliArguments: ["init", "--config", configFilePath],
      environment,
      extensionBinDirPath,
      workspaceDirPath,
    });

    assert.equal(initializeResult.status, 0, initializeResult.stderr);
    assert.equal(fs.existsSync(configFilePath), true);

    const invalidCommandResult = runBundledCli({
      cliArguments: ["unknown-command"],
      environment,
      extensionBinDirPath,
      workspaceDirPath,
    });

    assert.equal(invalidCommandResult.status, 1);
  } finally {
    fs.rmSync(temporaryDirPath, { force: true, recursive: true });
  }
});

function runBundledCli(options) {
  const commandOptions = {
    cwd: options.workspaceDirPath,
    encoding: "utf8",
    env: {
      ...options.environment,
      PATH: `${options.extensionBinDirPath}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${options.environment.PATH ?? ""}`,
    },
  };

  if (process.platform === "win32") {
    // Exercise the bundle directly on Windows. The .cmd launcher needs a Windows smoke test.
    return childProcess.spawnSync(
      process.execPath,
      [
        path.join(options.extensionBinDirPath, "..", "dist", "cli.js"),
        ...options.cliArguments,
      ],
      commandOptions,
    );
  }

  return childProcess.spawnSync("treety", options.cliArguments, commandOptions);
}
