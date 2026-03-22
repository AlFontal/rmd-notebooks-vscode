import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = await createWorkspaceFixture();
  const downloadedExecutablePath = await downloadAndUnzipVSCode("1.112.0");
  const appPath = resolveVsCodeAppPath(downloadedExecutablePath);
  const cliPath = resolveVsCodeCliPath(appPath);
  const testRuntimePath = await fs.mkdtemp(path.join(os.tmpdir(), "rmd-notebooks-vscode-runtime-"));
  const resultFilePath = path.resolve(__dirname, ".vscode-test-result.json");
  const proofFilePath = "/tmp/rmd-notebooks-vscode-proof.txt";
  const userDataDir = path.join(testRuntimePath, "user-data");
  const extensionsDir = path.join(testRuntimePath, "extensions");

  try {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.rm(resultFilePath, { force: true });
    await fs.rm(proofFilePath, { force: true });
    await launchVsCodeForTests(cliPath, [
      "--wait",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      `--extensionTestsPath=${extensionTestsPath}`,
      `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      workspacePath
    ]);
    await assertSuccessfulTestResult(resultFilePath, proofFilePath);
    console.log("VS Code integration tests passed.");
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testRuntimePath, { recursive: true, force: true });
    await fs.rm(resultFilePath, { force: true });
  }
}

async function createWorkspaceFixture(): Promise<string> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "rmd-notebooks-vscode-"));
  const fixtureRoot = path.resolve(__dirname, "../../../test/fixtures");

  await fs.mkdir(path.join(workspacePath, ".vscode"), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "rmdNotebooks.r.path": "R"
      },
      null,
      2
    )
  );

  await copyFixture(fixtureRoot, workspacePath, "simple.qmd", "simple.qmd");
  await copyFixture(fixtureRoot, workspacePath, "simple.Rmd", "simple.Rmd");
  await copyFixture(fixtureRoot, workspacePath, "multi-chunk.qmd", "multi-chunk.qmd");

  await fs.writeFile(
    path.join(workspacePath, "integration.qmd"),
    [
      "# Integration",
      "",
      "```{r first}",
      "x <- 1",
      "x + 1",
      "```",
      "",
      "```{r plotter}",
      "plot(cars)",
      "```",
      ""
    ].join("\n")
  );

  await fs.writeFile(
    path.join(workspacePath, "integration.Rmd"),
    [
      "---",
      'title: "Integration"',
      "output: html_document",
      "---",
      "",
      "```{r first}",
      "x <- 1",
      "x + 1",
      "```",
      "",
      "```{r plotter}",
      "plot(cars)",
      "```",
      ""
    ].join("\n")
  );

  return workspacePath;
}

async function copyFixture(root: string, workspacePath: string, sourceName: string, targetName: string): Promise<void> {
  const sourcePath = path.join(root, sourceName);
  const targetPath = path.join(workspacePath, targetName);
  await fs.copyFile(sourcePath, targetPath);
}

function resolveVsCodeAppPath(executablePath: string): string {
  return path.resolve(executablePath, "../../..");
}

function resolveVsCodeCliPath(appPath: string): string {
  return path.join(appPath, "Contents", "Resources", "app", "bin", "code");
}

async function launchVsCodeForTests(
  cliPath: string,
  args: string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`VS Code test launcher exited with code ${code}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`.trim()));
        return;
      }

      resolve();
    });
  });
}

async function assertSuccessfulTestResult(resultFilePath: string, proofFilePath: string): Promise<void> {
  const raw = await fs.readFile(resultFilePath, "utf8").catch(() => undefined);
  if (!raw) {
    throw new Error("VS Code integration tests did not produce a result file.");
  }

  const result = JSON.parse(raw) as {
    ok: boolean;
    failures?: number;
    error?: string;
    passes?: string[];
  };

  const reportLines = [
    "Rmd Notebooks VS Code Integration Proof",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Status: ${result.ok ? "PASS" : "FAIL"}`,
    `Failures: ${result.failures ?? 0}`,
    "",
    "Passed checks:",
    ...((result.passes ?? []).map((entry) => `- ${entry}`)),
    ""
  ];

  if (result.error) {
    reportLines.push("Error detail:", result.error, "");
  }

  await fs.writeFile(proofFilePath, reportLines.join("\n"), "utf8");

  if (!result.ok) {
    throw new Error(result.error ?? `${result.failures ?? "Unknown"} VS Code integration test(s) failed.`);
  }
}

main().catch((error) => {
  console.error("Failed to run VS Code integration tests");
  console.error(error);
  process.exit(1);
});
