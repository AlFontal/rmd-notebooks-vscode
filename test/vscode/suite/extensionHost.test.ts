import { strict as assert } from "node:assert";
import { afterEach, before, beforeEach, describe, it } from "mocha";
import * as vscode from "vscode";

interface InlineChunksExtensionApi {
  getDocumentState(documentUri: string): Promise<{
    snapshot: {
      documentUri: string;
      version: number;
      chunkIds: string[];
    } | undefined;
    outputs: Array<{
      chunkId: string;
      status: string;
      stale: boolean;
      outputTypes: string[];
    }>;
    outputChannelText: string;
  }>;
}

let extensionApi: InlineChunksExtensionApi;

const INTEGRATION_QMD = [
  "# Integration",
  "",
  "```{r first}",
  "x <- 1",
  "x + 1",
  "```",
  "",
  "```{r htmler}",
  "rmd_notebooks_html(\"<strong>hello from qmd</strong>\")",
  "```",
  "",
  "```{r plotter}",
  "plot(cars)",
  "```",
  ""
].join("\n");

const INTEGRATION_RMD = [
  "---",
  "title: \"Integration\"",
  "output: html_document",
  "---",
  "",
  "```{r first}",
  "x <- 1",
  "x + 1",
  "```",
  "",
  "```{r htmler}",
  "rmd_notebooks_html(\"<strong>hello from rmd</strong>\")",
  "```",
  "",
  "```{r plotter}",
  "plot(cars)",
  "```",
  ""
].join("\n");

describe("Rmd Notebooks Notebook Host", () => {
  before(async () => {
    const extension = vscode.extensions.getExtension<InlineChunksExtensionApi>("AlFontal.rmd-notebooks-vscode");
    assert.ok(extension, "Extension should be registered in the test host.");
    extensionApi = extension.isActive ? extension.exports : await extension.activate();
  });

  beforeEach(async () => {
    await resetIntegrationFixtures();
    await resetTestSettings();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    vscode.window.terminals.forEach((terminal) => terminal.dispose());
  });

  it("opens qmd files as notebooks", async () => {
    const editor = await openNotebookEditor("integration.qmd");

    assert.equal(editor.notebook.notebookType, "rmd-notebooks-vscode-notebook");
    assert.ok(editor.notebook.cellCount >= 4);
    assert.ok(editor.notebook.getCells().some((cell) => cell.kind === vscode.NotebookCellKind.Code));
  });

  it("runs the current qmd chunk and renders stdout inline", async () => {
    const editor = await openNotebookEditor("integration.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "application/vnd.code.notebook.stdout"))
    );

    assert.equal(state.snapshot?.chunkIds.length, 3);
    assert.ok(state.outputs.some((record) => record.outputTypes.includes("text")));
    assert.match(state.outputChannelText, /\[stdout\][\s\S]*\[1\] 2/);
  });

  it("runs the current rmd chunk and renders stdout inline", async () => {
    const editor = await openNotebookEditor("integration.rmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "application/vnd.code.notebook.stdout"))
    );

    assert.equal(state.snapshot?.chunkIds.length, 3);
    assert.ok(state.outputs.some((record) => record.outputTypes.includes("text")));
    assert.match(state.outputChannelText, /integration\.rmd[\s\S]*\[stdout\][\s\S]*\[1\] 2/i);
  });

  it("runs an html-producing qmd cell and renders html inline", async () => {
    const editor = await openNotebookEditor("integration.qmd");
    editor.selection = singleCellRange(findCodeCellIndex(editor.notebook, "rmd_notebooks_html"));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("html"))
    );

    const htmlCell = editor.notebook.cellAt(findCodeCellIndex(editor.notebook, "rmd_notebooks_html"));
    await waitForNotebookOutput(htmlCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "text/html"))
    );

    assert.ok(state.outputs.some((record) => record.outputTypes.includes("html")));
  });

  it("runs all qmd chunks and renders a plot inline", async () => {
    const editor = await openNotebookEditor("integration.qmd");

    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.length === 3 && candidate.outputs.some((record) => record.outputTypes.includes("image"))
    );

    const plotCell = editor.notebook.cellAt(findLastCodeCellIndex(editor.notebook));
    await waitForNotebookOutput(plotCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "image/png"))
    );

    assert.equal(state.outputs.length, 3);
    assert.ok(state.outputs.some((record) => record.outputTypes.includes("image")));
  });

  it("toggles between notebook view and raw source view", async () => {
    const editor = await openNotebookEditor("integration.qmd");

    await vscode.commands.executeCommand("rmdNotebooks.toggleSourceView");

    const textEditor = await waitFor(() => {
      const candidate = vscode.window.activeTextEditor;
      return candidate?.document.uri.toString() === editor.notebook.uri.toString() ? candidate : undefined;
    });

    assert.ok(textEditor.document.getText().includes("```{r first}"));

    await vscode.commands.executeCommand("rmdNotebooks.toggleSourceView");

    const notebookEditor = await waitFor(() => {
      const candidate = vscode.window.activeNotebookEditor;
      return candidate?.notebook.uri.toString() === editor.notebook.uri.toString() ? candidate : undefined;
    });

    assert.equal(notebookEditor.notebook.notebookType, "rmd-notebooks-vscode-notebook");
  });

  it("edits chunk header metadata and preserves it in raw source", async () => {
    const editor = await openNotebookEditor("integration.qmd");
    const codeCellIndex = findFirstCodeCellIndex(editor.notebook);
    editor.selection = singleCellRange(codeCellIndex);

    const stateBefore = await extensionApi.getDocumentState(editor.notebook.uri.toString());
    const firstChunkId = stateBefore.snapshot?.chunkIds[0];
    assert.ok(firstChunkId, "Expected the first chunk id to exist.");

    await vscode.commands.executeCommand(
      "rmdNotebooks.editChunkHeader",
      editor.notebook.uri.toString(),
      firstChunkId,
      "r renamed, echo=FALSE, warning=FALSE"
    );

    const updatedCell = await waitFor(() => {
      const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === editor.notebook.uri.toString());
      if (!notebook) {
        return undefined;
      }

      const metadata = notebook.cellAt(codeCellIndex).metadata?.rmdNotebooks;
      return metadata?.header === "```{r renamed, echo=FALSE, warning=FALSE}" ? notebook.cellAt(codeCellIndex) : undefined;
    });

    assert.equal(updatedCell.metadata?.rmdNotebooks?.header, "```{r renamed, echo=FALSE, warning=FALSE}");

    await vscode.commands.executeCommand("rmdNotebooks.viewSource");

    const savedBytes = await vscode.workspace.fs.readFile(editor.notebook.uri);
    const savedSource = Buffer.from(savedBytes).toString("utf8");

    assert.ok(savedSource.includes("```{r renamed, echo=FALSE, warning=FALSE}"));
  });

  it("skips execution for eval=FALSE", async () => {
    await writeFixture(
      "eval-false.qmd",
      [
        "# Eval false",
        "",
        "```{r skipped, eval=FALSE}",
        "stop('should not run')",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("eval-false.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) => candidate.outputs.length === 1);
    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));

    assert.equal(state.outputs[0].status, "success");
    assert.deepEqual(state.outputs[0].outputTypes, []);
    assert.equal(codeCell.outputs.length, 0);
  });

  it("hides text results for results='hide' while keeping plot output", async () => {
    await writeFixture(
      "results-hide.qmd",
      [
        "# Results hide",
        "",
        "```{r hidden-results, results='hide'}",
        "cat('text should be hidden\\n')",
        "plot(cars)",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("results-hide.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.length === 1 && candidate.outputs[0].outputTypes.includes("image")
    );
    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "image/png"))
    );

    assert.deepEqual(state.outputs[0].outputTypes, ["image"]);
    assert.ok(renderedCell.outputs.every((output) => output.items.every((item) => item.mime !== "application/vnd.code.notebook.stdout")));
  });

  it("marks qmd output stale after editing the cell body", async () => {
    const editor = await openNotebookEditor("integration.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success")
    );

    const targetCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetCell.document.uri, new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5)), "x + 3");
    await vscode.workspace.applyEdit(edit);

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.stale)
    );

    assert.ok(state.outputs.some((record) => record.stale));
  });

  it("clears current output and all outputs for notebooks", async () => {
    const editor = await openNotebookEditor("integration.qmd");
    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    await waitForDocumentState(editor.notebook.uri, (candidate) => candidate.outputs.length === 3);

    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.clearCurrentOutput");

    const afterCurrentClear = await waitForDocumentState(editor.notebook.uri, (candidate) => candidate.outputs.length === 2);
    assert.equal(afterCurrentClear.outputs.length, 2);

    await vscode.commands.executeCommand("rmdNotebooks.clearAllOutputs");
    const afterAllClear = await waitForDocumentState(editor.notebook.uri, (candidate) => candidate.outputs.length === 0);
    assert.equal(afterAllClear.outputs.length, 0);
  });

  it("restarts the per-document R session", async () => {
    await writeFixture(
      "restart-session.qmd",
      [
        "# Restart session",
        "",
        "```{r assigner}",
        "x <- 41",
        "```",
        "",
        "```{r reader}",
        "x + 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("restart-session.qmd");

    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success")
    );

    await vscode.commands.executeCommand("rmdNotebooks.restartSession");

    editor.selection = singleCellRange(findLastCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "error")
    );

    const secondCell = editor.notebook.cellAt(findLastCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(secondCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "application/vnd.code.notebook.stderr"))
    );

    assert.ok(state.outputs.some((record) => record.status === "error"));
    assert.ok(renderedCell.outputs.some((output) => output.items.some((item) => item.mime === "application/vnd.code.notebook.stderr")));
  });

  it("falls back to an R terminal when inline execution times out", async () => {
    await writeFixture(
      "interactive-timeout.qmd",
      [
        "# Interactive timeout",
        "",
        "```{r waiting}",
        "Sys.sleep(2)",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 1000);
    await updateTestSetting("execution.interactiveFallbackBehavior", "terminal");

    const editor = await openNotebookEditor("interactive-timeout.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    await waitFor(() => {
      const terminal = vscode.window.terminals.find((candidate) => candidate.name === "Rmd Notebooks R");
      return terminal ?? undefined;
    }, 15000);

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.outputTypes.includes("text"))
    );

    assert.ok(state.outputs.some((record) => record.outputTypes.includes("text")));
  });
});

async function openNotebookEditor(name: string): Promise<vscode.NotebookEditor> {
  const uri = getWorkspaceFileUri(name);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  return vscode.window.showNotebookDocument(notebook);
}

async function resetIntegrationFixtures(): Promise<void> {
  await writeFixture("integration.qmd", INTEGRATION_QMD);
  await writeFixture("integration.rmd", INTEGRATION_RMD);
}

async function writeFixture(name: string, contents: string): Promise<void> {
  await vscode.workspace.fs.writeFile(getWorkspaceFileUri(name), Buffer.from(contents, "utf8"));
}

async function resetTestSettings(): Promise<void> {
  await updateTestSetting("execution.interactiveFallbackTimeoutMs", 15000);
  await updateTestSetting("execution.interactiveFallbackBehavior", "prompt");
}

async function updateTestSetting(section: string, value: string | number): Promise<void> {
  await vscode.workspace.getConfiguration("rmdNotebooks").update(section, value, vscode.ConfigurationTarget.Workspace);
}

function getWorkspaceFileUri(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "A workspace folder should be available for integration tests.");
  return vscode.Uri.joinPath(folder.uri, name);
}

function findFirstCodeCellIndex(notebook: vscode.NotebookDocument): number {
  const index = notebook.getCells().findIndex((cell) => cell.kind === vscode.NotebookCellKind.Code);
  assert.ok(index >= 0, "A code cell should exist.");
  return index;
}

function findLastCodeCellIndex(notebook: vscode.NotebookDocument): number {
  const cells = notebook.getCells();
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index].kind === vscode.NotebookCellKind.Code) {
      return index;
    }
  }

  throw new Error("A code cell should exist.");
}

function findCodeCellIndex(notebook: vscode.NotebookDocument, snippet: string): number {
  const index = notebook.getCells().findIndex(
    (cell) => cell.kind === vscode.NotebookCellKind.Code && cell.document.getText().includes(snippet)
  );
  assert.ok(index >= 0, `Expected a code cell containing ${snippet}.`);
  return index;
}

function singleCellRange(index: number): vscode.NotebookRange {
  return new vscode.NotebookRange(index, index + 1);
}

async function waitForNotebookOutput(
  originalCell: vscode.NotebookCell,
  predicate: (cell: vscode.NotebookCell) => boolean,
  timeoutMs = 30000
): Promise<vscode.NotebookCell> {
  return waitFor(() => {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === originalCell.notebook.uri.toString());
    if (!notebook) {
      return undefined;
    }

    const cell = notebook.cellAt(originalCell.index);
    return predicate(cell) ? cell : undefined;
  }, timeoutMs);
}

async function waitForDocumentState(
  uri: vscode.Uri,
  predicate: (state: Awaited<ReturnType<InlineChunksExtensionApi["getDocumentState"]>>) => boolean
): Promise<Awaited<ReturnType<InlineChunksExtensionApi["getDocumentState"]>>> {
  return waitFor(async () => {
    const state = await extensionApi.getDocumentState(uri.toString());
    return predicate(state) ? state : undefined;
  });
}

async function waitFor<T>(producer: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await producer();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
