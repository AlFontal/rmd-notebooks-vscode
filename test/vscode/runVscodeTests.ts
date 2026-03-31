import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = await createWorkspaceFixture();
  const resultFilePath = path.resolve(__dirname, ".vscode-test-result.json");
  const proofFilePath = "/tmp/rmd-notebooks-vscode-proof.txt";

  try {
    await fs.rm(resultFilePath, { force: true });
    await fs.rm(proofFilePath, { force: true });
    await runTests({
      version: "1.112.0",
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-updates"
      ],
      reuseMachineInstall: false
    });
    await assertSuccessfulTestResult(resultFilePath, proofFilePath);
    console.log("VS Code integration tests passed.");
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
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
