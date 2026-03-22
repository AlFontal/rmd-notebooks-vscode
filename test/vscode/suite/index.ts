import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 60000
  });

  const testsRoot = __dirname;

  return new Promise((resolve, reject) => {
    const files = collectTestFiles(testsRoot);
    const failures: Array<{ title: string; error?: string }> = [];
    const passes: string[] = [];

    for (const file of files) {
      mocha.addFile(file);
    }

    try {
      const runner = mocha.run((failureCount: number) => {
        if (failureCount > 0) {
          writeResultFile({
            ok: false,
            failures: failureCount,
            error: failures.map((failure) => `${failure.title}\n${failure.error ?? ""}`.trim()).join("\n\n"),
            passes
          });
          reject(new Error(`${failureCount} VS Code integration test(s) failed.`));
          return;
        }

        writeResultFile({ ok: true, failures: 0, passes });
        resolve();
      });

      runner.on("fail", (test, error) => {
        failures.push({
          title: test.fullTitle(),
          error: error instanceof Error ? error.stack ?? error.message : String(error)
        });
      });
      runner.on("pass", (test) => {
        passes.push(test.fullTitle());
      });
    } catch (runError) {
      writeResultFile({
        ok: false,
        error: runError instanceof Error ? runError.stack ?? runError.message : String(runError),
        passes
      });
      reject(runError);
    }
  });
}

function collectTestFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(entryPath);
    }
  }

  return files;
}

function writeResultFile(result: { ok: boolean; failures?: number; error?: string; passes?: string[] }): void {
  const resultPath = path.resolve(__dirname, "../.vscode-test-result.json");
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
}
