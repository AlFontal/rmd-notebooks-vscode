import { strict as assert } from "node:assert";
import { afterEach, before, beforeEach, describe, it } from "mocha";
import * as vscode from "vscode";
import { PreviewServices, previewNotebookHtml } from "../../../src/commands/previewHtml";

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
  setTestPromptResponses(responses: Array<{ cancelled?: boolean; value?: string }>): void;
  clearTestPromptResponses(): void;
  takeTestPromptRequests(): Array<{
    kind: string;
    title?: string;
    prompt: string;
    placeHolder?: string;
    defaultValue?: string;
    allowEmpty?: boolean;
    choices?: Array<{
      label: string;
      value: string;
      description?: string;
    }>;
  }>;
  getPythonEnvironmentState(documentUri: string): {
    environments: Array<{ id: string; path: string; label: string }>;
    selectedPath?: string;
  };
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
    await closeAllEditors();
    await resetIntegrationFixtures();
    await resetTestSettings();
  });

  afterEach(async () => {
    extensionApi.clearTestPromptResponses();
    await closeAllEditors();
    vscode.window.terminals.forEach((terminal) => terminal.dispose());
  });

  it("opens qmd files as notebooks", async () => {
    const editor = await openNotebookEditor("integration.qmd");

    assert.equal(editor.notebook.notebookType, "rmd-notebooks-vscode-notebook");
    assert.ok(editor.notebook.cellCount >= 4);
    assert.ok(editor.notebook.getCells().some((cell) => cell.kind === vscode.NotebookCellKind.Code));
  });

  it("opens YAML frontmatter as a non-executable source-preserving cell", async () => {
    const editor = await openNotebookEditor("integration.rmd");
    const frontmatter = editor.notebook.cellAt(0);

    assert.equal(frontmatter.kind, vscode.NotebookCellKind.Code);
    assert.equal(frontmatter.document.languageId, "yaml");
    assert.equal(frontmatter.document.getText(), 'title: "Integration"\noutput: html_document');
    assert.equal(frontmatter.metadata?.rmdNotebooks?.kind, "frontmatter");

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      frontmatter.document.uri,
      new vscode.Range(new vscode.Position(0, 0), frontmatter.document.lineAt(0).range.end),
      'title: "Updated integration"'
    );
    await vscode.workspace.applyEdit(edit);
    assert.ok(await editor.notebook.save());

    const saved = Buffer.from(await vscode.workspace.fs.readFile(editor.notebook.uri)).toString("utf8");
    assert.ok(saved.startsWith('---\ntitle: "Updated integration"\noutput: html_document\n---'));

    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    const state = await waitForDocumentState(editor.notebook.uri, (candidate) => candidate.outputs.length === 3);
    assert.equal(state.snapshot?.chunkIds.length, 3);
  });

  it("opens qmd files as notebooks through the default editor path", async () => {
    const uri = getWorkspaceFileUri("integration.qmd");

    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(
      () => vscode.window.activeNotebookEditor?.notebook.uri.toString() === uri.toString() ? true : undefined,
      3000
    );

    assert.equal(vscode.window.activeNotebookEditor?.notebook.notebookType, "rmd-notebooks-vscode-notebook");
  });

  it("routes saved notebook previews and restores Rmd notebook view after failures", async () => {
    const calls: string[] = [];
    const services: PreviewServices = {
      ensureIntegration: async (extensionId, commandId) => {
        calls.push(`ensure:${extensionId}:${commandId}`);
        return true;
      },
      executeCommand: async (commandId) => {
        calls.push(`execute:${commandId}`);
        if (commandId === "r.rmarkdown.showPreviewToSide") {
          throw new Error("preview failed");
        }
      },
      openRawSource: async () => {
        calls.push("openRaw");
      },
      restoreNotebook: async () => {
        calls.push("restoreNotebook");
      },
      showWarning: async (message) => {
        calls.push(`warning:${message}`);
      }
    };

    const qmdResult = await previewNotebookHtml(
      {
        uri: vscode.Uri.file("/tmp/preview.qmd"),
        save: async () => {
          calls.push("save:qmd");
          return true;
        }
      },
      services
    );
    assert.equal(qmdResult, "previewed");
    assert.deepEqual(calls.slice(0, 5), [
      "save:qmd",
      "ensure:quarto.quarto:quarto.preview",
      "openRaw",
      "execute:quarto.preview",
      "restoreNotebook"
    ]);

    await assert.rejects(
      previewNotebookHtml(
        {
          uri: vscode.Uri.file("/tmp/preview.Rmd"),
          save: async () => {
            calls.push("save:rmd");
            return true;
          }
        },
        services
      ),
      /preview failed/
    );
    assert.deepEqual(calls.slice(-5), [
      "save:rmd",
      "ensure:REditorSupport.r:r.rmarkdown.showPreviewToSide",
      "openRaw",
      "execute:r.rmarkdown.showPreviewToSide",
      "restoreNotebook"
    ]);
  });

  it("does not preview when saving is cancelled or an integration is missing", async () => {
    const calls: string[] = [];
    const services: PreviewServices = {
      ensureIntegration: async () => {
        calls.push("ensure");
        return false;
      },
      executeCommand: async () => {
        calls.push("execute");
      },
      openRawSource: async () => {
        calls.push("openRaw");
      },
      restoreNotebook: async () => {
        calls.push("restoreNotebook");
      },
      showWarning: async () => {
        calls.push("warning");
      }
    };

    const cancelled = await previewNotebookHtml(
      { uri: vscode.Uri.file("/tmp/preview.qmd"), save: async () => false },
      services
    );
    assert.equal(cancelled, "cancelled");
    assert.deepEqual(calls, ["warning"]);

    const missing = await previewNotebookHtml(
      { uri: vscode.Uri.file("/tmp/preview.qmd"), save: async () => true },
      services
    );
    assert.equal(missing, "missing");
    assert.deepEqual(calls, ["warning", "ensure"]);

    let unsupportedSaveCalled = false;
    const unsupported = await previewNotebookHtml(
      {
        uri: vscode.Uri.file("/tmp/preview.md"),
        save: async () => {
          unsupportedSaveCalled = true;
          return true;
        }
      },
      services
    );
    assert.equal(unsupported, "unsupported");
    assert.equal(unsupportedSaveCalled, false);
    assert.deepEqual(calls, ["warning", "ensure", "warning"]);
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

  it("runs Python chunks in a persistent qmd session and renders rich output", async () => {
    await writeFixture(
      "python-integration.qmd",
      [
        "# Python integration",
        "",
        "```{python setup}",
        "shared_value = 40",
        "print('python ready')",
        "```",
        "",
        "```{python dependent}",
        "print(f'answer={shared_value + 2}')",
        "```",
        "",
        "```{python rich}",
        "class RichValue:",
        "    def _repr_html_(self):",
        "        return '<strong>python html</strong>'",
        "RichValue()",
        "```",
        "",
        "```{python mimebundle}",
        "import base64",
        "class MimeBundlePlot:",
        "    def _repr_mimebundle_(self):",
        "        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=')",
        "        return ({'image/png': png}, {'image/png': {'width': 1, 'height': 1}})",
        "MimeBundlePlot()",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("python-integration.qmd");
    const pythonCells = editor.notebook.getCells().filter((cell) => cell.document.languageId === "python");
    assert.equal(pythonCells.length, 4);

    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.filter((record) => record.status === "success").length === 4
    );

    assert.ok(state.outputChannelText.includes("python ready"));
    assert.ok(state.outputChannelText.includes("answer=42"));
    assert.ok(state.outputs.some((record) => record.outputTypes.includes("html")));
    assert.ok(state.outputs.some((record) => record.outputTypes.includes("image")));

    const richCell = pythonCells[2];
    const renderedRichCell = await waitForNotebookOutput(richCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "text/html"))
    );
    assert.ok(notebookOutputText(renderedRichCell, "text/html").includes("python html"));
    assert.equal(await waitForExecutionOrder(editor.notebook.uri, pythonCells[0].index), 1);
    assert.equal(await waitForExecutionOrder(editor.notebook.uri, pythonCells[2].index), 3);

    const environmentState = extensionApi.getPythonEnvironmentState(editor.notebook.uri.toString());
    assert.ok(environmentState.environments.length > 0, "Expected Python extension environment discovery.");
    assert.ok(environmentState.selectedPath, "Expected the preferred Python environment to be selected.");
    assert.ok(
      environmentState.environments.some((environment) => environment.path === environmentState.selectedPath),
      `Selected interpreter was not one of the discovered environments: ${environmentState.selectedPath}`
    );

    await waitForNotebookOutput(pythonCells[3], (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "image/png"))
    );

    assert.ok(await editor.notebook.save());
    const saved = Buffer.from(await vscode.workspace.fs.readFile(editor.notebook.uri)).toString("utf8");
    assert.ok(saved.includes("```{python setup}"));
    assert.ok(saved.includes("shared_value = 40"));
  });

  it("handles Python input() through the notebook prompt UI", async () => {
    await writeFixture(
      "python-input.qmd",
      [
        "# Python input",
        "",
        "```{python prompt}",
        "package = input('Package name? ')",
        "print(f'value={package}')",
        "```",
        ""
      ].join("\n")
    );
    extensionApi.setTestPromptResponses([{ value: "polars" }]);

    const editor = await openNotebookEditor("python-input.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );
    const requests = extensionApi.takeTestPromptRequests();
    assert.ok(requests.some((request) => request.kind === "input" && request.prompt.includes("Package name?")));
    assert.ok(state.outputChannelText.includes("value=polars"));
  });

  it("restarts the per-document Python session", async () => {
    await writeFixture(
      "python-restart.qmd",
      [
        "# Python restart",
        "",
        "```{python assigner}",
        "python_restart_value = 41",
        "```",
        "",
        "```{python reader}",
        "python_restart_value + 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("python-restart.qmd");
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
    assert.ok(state.outputChannelText.includes("NameError"));
  });

  it("interrupts Python execution and keeps the session usable", async () => {
    await writeFixture(
      "python-interrupt.qmd",
      [
        "# Python interrupt",
        "",
        "```{python slow}",
        "import time",
        "time.sleep(10)",
        "print('should not finish')",
        "```",
        "",
        "```{python recovery}",
        "print('python recovered')",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("python-interrupt.qmd");
    const uri = editor.notebook.uri.toString();
    const initial = await extensionApi.getDocumentState(uri);
    const [slowId, recoveryId] = initial.snapshot?.chunkIds ?? [];
    assert.ok(slowId && recoveryId);

    const slowRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, slowId);
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === slowId && record.status === "running")
    );
    await vscode.commands.executeCommand("rmdNotebooks.interruptSession", uri);
    await slowRun;
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === slowId && record.status === "cancelled")
    );

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, recoveryId);
    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === recoveryId && record.status === "success")
    );
    assert.ok(state.outputChannelText.includes("python recovered"));
    assert.ok(!state.outputChannelText.includes("should not finish"));
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

  it("renders data frames as escaped HTML without losing matrix columns", async () => {
    await writeFixture(
      "data-frame-html.qmd",
      [
        "# Data frame HTML",
        "",
        "```{r frame}",
        "data.frame(text = c('<b>&', 'plain'), matrix_values = I(matrix(1:4, nrow = 2)))",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("data-frame-html.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "text/html"))
    );
    const html = notebookOutputText(renderedCell, "text/html");

    assert.ok(html.includes("&lt;b&gt;&amp;"), "Cell contents should be HTML-escaped.");
    assert.ok(html.includes("matrix_values.1") && html.includes("matrix_values.2"), "Matrix columns should be expanded like normal R output.");
    assert.match(html, /<td>3<\/td>[\s\S]*<td>4<\/td>/, "Expanded matrix-column values should not be dropped.");
  });

  it("truncates data-frame rows and columns and can restore plain-text output", async () => {
    await writeFixture(
      "data-frame-truncation.qmd",
      [
        "# Data frame truncation",
        "",
        "```{r frame}",
        "data.frame(c1 = 1:6, c2 = 11:16, c3 = 21:26, c4 = 31:36, c5 = 41:46, c6 = 51:56)",
        "```",
        ""
      ].join("\n")
    );
    await updateTestSetting("output.dataFrameMaxRows", 4);
    await updateTestSetting("output.dataFrameMaxColumns", 4);

    const editor = await openNotebookEditor("data-frame-truncation.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "text/html"))
    );
    const html = notebookOutputText(renderedCell, "text/html");
    assert.ok(html.includes("6 rows &times; 6 columns"));
    assert.ok(html.includes("<th>c1</th>") && html.includes("<th>c2</th>"));
    assert.ok(html.includes("<th>c5</th>") && html.includes("<th>c6</th>"));
    assert.ok(!html.includes("<th>c3</th>") && !html.includes("<th>c4</th>"));
    assert.ok(html.includes("rmd-df-ellipsis"));

    await updateTestSetting("output.dataFrameRender", false);
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");
    const plainCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) => output.items.some((item) => item.mime === "application/vnd.code.notebook.stdout")) &&
      cell.outputs.every((output) => output.items.every((item) => item.mime !== "text/html"))
    );
    assert.ok(notebookOutputText(plainCell, "application/vnd.code.notebook.stdout").includes("c1"));
  });

  it("evaluates inline chunks in the global environment without exposing protocol internals", async () => {
    await writeFixture(
      "global-env.qmd",
      [
        "# Global environment",
        "",
        "```{r global-check}",
        "x_global_probe <- 42",
        "cat(sprintf('global=%s\\n', exists('x_global_probe', envir = .GlobalEnv, inherits = FALSE)))",
        "cat(sprintf('protocol=%s\\n', exists('rmd_notebooks_execute', envir = .GlobalEnv, inherits = FALSE)))",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("global-env.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) =>
        output.items.some((item) => Buffer.from(item.data).toString("utf8").includes("global=TRUE"))
      )
    );

    const outputText = renderedCell.outputs
      .flatMap((output) => output.items)
      .map((item) => Buffer.from(item.data).toString("utf8"))
      .join("\n");
    assert.ok(outputText.includes("global=TRUE"));
    assert.ok(outputText.includes("protocol=FALSE"));
  });

  it("evaluates inline R prose in document order and preserves its source", async () => {
    await writeFixture(
      "inline-prose.qmd",
      [
        "# Inline prose",
        "",
        "```{r setup}",
        "inline_value <- 41",
        "```",
        "",
        "The answer is `{r} inline_value + 1` and `r paste(\"hello\", \"world\")`.",
        "",
        "```{r update}",
        "inline_value <- inline_value + 1",
        "```",
        "",
        "The updated answer is `r inline_value`.",
        ""
      ].join("\n")
    );

    let editor = await openNotebookEditor("inline-prose.qmd");
    const inlineCells = editor.notebook.getCells().filter(
      (cell) => cell.metadata?.rmdNotebooks?.kind === "inline"
    );
    assert.equal(inlineCells.length, 2);
    assert.ok(inlineCells.every((cell) => cell.kind === vscode.NotebookCellKind.Code));
    assert.ok(inlineCells.every((cell) => cell.document.languageId === "markdown"));

    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    const state = await waitForDocumentState(
      editor.notebook.uri,
      (candidate) => candidate.outputs.length === 4 && candidate.outputs.filter((output) => output.outputTypes.includes("markdown")).length === 2
    );
    assert.equal(state.snapshot?.chunkIds.length, 4);

    const firstRendered = await waitForNotebookOutput(inlineCells[0], (cell) =>
      notebookOutputText(cell, "text/markdown").includes("The answer is 42 and hello world.")
    );
    const secondRendered = await waitForNotebookOutput(inlineCells[1], (cell) =>
      notebookOutputText(cell, "text/markdown").includes("The updated answer is 42.")
    );
    assert.ok(notebookOutputText(firstRendered, "text/markdown").includes("The answer is 42 and hello world."));
    assert.ok(notebookOutputText(secondRendered, "text/markdown").includes("The updated answer is 42."));

    const sourceEdit = new vscode.WorkspaceEdit();
    sourceEdit.replace(
      inlineCells[0].document.uri,
      fullDocumentRange(inlineCells[0].document),
      inlineCells[0].document.getText().replace("inline_value + 1", "inline_value + 2")
    );
    await vscode.workspace.applyEdit(sourceEdit);
    await waitForDocumentState(
      editor.notebook.uri,
      (candidate) => candidate.outputs.some((output) => output.stale && output.outputTypes.includes("markdown"))
    );
    await waitForNotebookOutput(inlineCells[0], (cell) =>
      notebookOutputText(cell, "text/markdown").includes("Stale output")
    );
    await vscode.commands.executeCommand(
      "rmdNotebooks.runInlineCell",
      editor.notebook.uri.toString(),
      undefined,
      inlineCells[0].index
    );
    await waitForNotebookOutput(inlineCells[0], (cell) =>
      notebookOutputText(cell, "text/markdown").includes("The answer is 44 and hello world.")
    );

    assert.ok(await editor.notebook.save());
    const savedSource = Buffer.from(await vscode.workspace.fs.readFile(editor.notebook.uri)).toString("utf8");
    assert.ok(savedSource.includes("The answer is `{r} inline_value + 2` and `r paste"));
    assert.ok(!savedSource.includes("The answer is 42"));

    await closeAllEditors();
    editor = await openNotebookEditor("inline-prose.qmd");
    const reopenedInline = editor.notebook.getCells().find(
      (cell) => cell.metadata?.rmdNotebooks?.kind === "inline" && cell.document.getText().includes("The answer is")
    );
    assert.ok(reopenedInline);
    await waitForNotebookOutput(reopenedInline, (cell) =>
      notebookOutputText(cell, "text/markdown").includes("The answer is 44 and hello world.")
    );

    editor.selection = singleCellRange(reopenedInline.index);
    await vscode.commands.executeCommand("rmdNotebooks.clearCurrentOutput");
    await waitForNotebookOutput(reopenedInline, (cell) =>
      notebookOutputText(cell, "text/markdown").includes("`{r} inline_value + 2`")
    );
  });

  it("promotes newly authored inline prose and retains source beside evaluation errors", async () => {
    await writeFixture("promote-inline.qmd", "# Promotion\n\nPlain prose.\n");
    const editor = await openNotebookEditor("promote-inline.qmd");
    const markupIndex = editor.notebook.getCells().findIndex(
      (cell) => cell.kind === vscode.NotebookCellKind.Markup && cell.document.getText().includes("Plain prose")
    );
    assert.ok(markupIndex >= 0);
    const markup = editor.notebook.cellAt(markupIndex);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(markup.document.uri, fullDocumentRange(markup.document), "Value: `r stop(\"inline boom\")`.");
    await vscode.workspace.applyEdit(edit);

    editor.selection = singleCellRange(markupIndex);
    await vscode.commands.executeCommand("rmdNotebooks.runInlineCell");

    const promoted = editor.notebook.cellAt(markupIndex);
    assert.equal(promoted.metadata?.rmdNotebooks?.kind, "inline");
    const rendered = await waitForNotebookOutput(promoted, (cell) =>
      notebookOutputText(cell, "text/markdown").includes("stop") &&
      notebookOutputText(cell, "application/vnd.code.notebook.stderr").includes("inline boom")
    );
    assert.ok(notebookOutputText(rendered, "text/markdown").includes('Value: `r stop("inline boom")`.'));
  });

  it("honors project .Rprofile startup files by default", async () => {
    await writeFixture(".Rprofile", "rprofile_marker <- 41\n");
    await writeFixture(
      "rprofile-startup.qmd",
      [
        "# R profile startup",
        "",
        "```{r profile-check}",
        "rprofile_marker + 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("rprofile-startup.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) =>
        output.items.some((item) => Buffer.from(item.data).toString("utf8").includes("[1] 42"))
      )
    );

    assert.ok(
      renderedCell.outputs.some((output) =>
        output.items.some((item) => Buffer.from(item.data).toString("utf8").includes("[1] 42"))
      )
    );
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
    await writeFixture(
      "edit-header.qmd",
      [
        "# Edit header",
        "",
        "```{r first}",
        "x <- 1",
        "x + 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("edit-header.qmd");
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

  it("preserves chunk header options when saving after a body edit", async () => {
    await writeFixture(
      "preserve-options.qmd",
      [
        "# Preserve options",
        "",
        "```{r eval=FALSE}",
        "print(\"should stay non-executable\")",
        "```",
        "",
        "```{r labeled, echo=FALSE, warning=FALSE}",
        "x <- 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("preserve-options.qmd");
    const firstCodeCellIndex = findFirstCodeCellIndex(editor.notebook);
    const firstCell = editor.notebook.cellAt(firstCodeCellIndex);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      firstCell.document.uri,
      new vscode.Range(new vscode.Position(0, 0), firstCell.document.lineAt(0).range.end),
      "print(\"edited body\")"
    );
    await vscode.workspace.applyEdit(edit);

    await waitFor(() => (firstCell.document.getText().includes("edited body") ? true : undefined));

    const saved = await editor.notebook.save();
    assert.ok(saved, "Notebook save should succeed.");

    const savedBytes = await vscode.workspace.fs.readFile(editor.notebook.uri);
    const savedSource = Buffer.from(savedBytes).toString("utf8");

    assert.ok(
      savedSource.includes("```{r eval=FALSE}"),
      `Expected unlabeled header to retain eval=FALSE; got:\n${savedSource}`
    );
    assert.ok(
      savedSource.includes("```{r labeled, echo=FALSE, warning=FALSE}"),
      `Expected labeled header to retain its options; got:\n${savedSource}`
    );
  });

  it("does not mark the notebook dirty after opening an unedited file", async () => {
    await writeFixture(
      "clean-open.qmd",
      [
        "# Clean open",
        "",
        "```{r setup, include=FALSE}",
        "x <- 1",
        "```",
        "",
        "```{r labeled, echo=FALSE, warning=FALSE}",
        "y <- 2",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("clean-open.qmd");

    await waitForDocumentState(
      editor.notebook.uri,
      (state) => (state.snapshot?.chunkIds.length ?? 0) >= 2
    );

    assert.equal(
      editor.notebook.isDirty,
      false,
      "Opening an unedited notebook should not mark it dirty."
    );
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
    await writeFixture(
      "stale-output.qmd",
      [
        "# Stale output",
        "",
        "```{r first}",
        "x <- 1",
        "x + 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("stale-output.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success")
    );

    const targetCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetCell.document.uri, new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5)), "x + 3");
    const edited = await vscode.workspace.applyEdit(edit);
    assert.ok(edited, "Cell body edit should be applied.");
    await waitFor(() => (targetCell.document.getText().includes("x + 3") ? true : undefined));

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.stale)
    );

    assert.ok(state.outputs.some((record) => record.stale));
  });

  it("clears current output and all outputs for notebooks", async () => {
    await writeFixture(
      "clear-output.qmd",
      [
        "# Clear output",
        "",
        "```{r first}",
        "1 + 1",
        "```",
        "",
        "```{r second}",
        "2 + 2",
        "```",
        "",
        "```{r plotter}",
        "plot(cars)",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("clear-output.qmd");
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

  it("persists outputs cleared from the built-in notebook toolbar", async () => {
    await writeFixture(
      "clear-toolbar-output.qmd",
      [
        "# Clear toolbar output",
        "",
        "```{r first}",
        "1 + 1",
        "```",
        "",
        "```{r second}",
        "2 + 2",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("clear-toolbar-output.qmd");
    const uri = editor.notebook.uri;
    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    await waitForDocumentState(uri, (candidate) => candidate.outputs.length === 2);

    // This is VS Code's built-in toolbar action, not the extension command.
    await vscode.commands.executeCommand("notebook.clearAllCellsOutputs");
    await waitFor(() =>
      editor.notebook.getCells().every((cell) => cell.outputs.length === 0) ? true : undefined
    );

    await closeAllEditors();
    const reopened = await openNotebookEditor("clear-toolbar-output.qmd");
    await sleep(300);

    const state = await extensionApi.getDocumentState(uri.toString());
    assert.equal(state.outputs.length, 0, "Cleared toolbar outputs should be removed from persisted extension state.");
    assert.ok(
      reopened.notebook.getCells().every((cell) => cell.outputs.length === 0),
      "Cleared toolbar outputs should not reappear when the notebook is reopened."
    );
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

  it("counts executions per notebook, not across notebooks", async () => {
    await writeFixture(
      "exec-count-a.qmd",
      [
        "# Count A",
        "",
        "```{r a_one}",
        "1 + 1",
        "```",
        "",
        "```{r a_two}",
        "2 + 2",
        "```",
        ""
      ].join("\n")
    );
    await writeFixture(
      "exec-count-b.qmd",
      [
        "# Count B",
        "",
        "```{r b_one}",
        "3 + 3",
        "```",
        ""
      ].join("\n")
    );

    const editorA = await openNotebookEditor("exec-count-a.qmd");
    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    await waitForDocumentState(editorA.notebook.uri, (candidate) =>
      candidate.outputs.filter((record) => record.status === "success").length === 2
    );
    assert.equal(await waitForExecutionOrder(editorA.notebook.uri, findFirstCodeCellIndex(editorA.notebook)), 1);
    assert.equal(await waitForExecutionOrder(editorA.notebook.uri, findLastCodeCellIndex(editorA.notebook)), 2);

    const editorB = await openNotebookEditor("exec-count-b.qmd");
    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    await waitForDocumentState(editorB.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success")
    );

    // The bug this guards against: a single global counter kept climbing across
    // notebooks, so B's first cell showed [3] (continuing from A's two runs). Each
    // notebook has its own R session, so its count must start at [1].
    const firstB = await waitForExecutionOrder(editorB.notebook.uri, findFirstCodeCellIndex(editorB.notebook));
    assert.equal(firstB, 1, `Notebook B's first run should be [1], not a continuation of notebook A; got [${firstB}].`);
  });

  it("resets the execution count when the R session restarts", async () => {
    await writeFixture(
      "exec-count-reset.qmd",
      [
        "# Count reset",
        "",
        "```{r one}",
        "1 + 1",
        "```",
        "",
        "```{r two}",
        "2 + 2",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("exec-count-reset.qmd");
    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.filter((record) => record.status === "success").length === 2
    );
    const lastCellIndex = findLastCodeCellIndex(editor.notebook);
    assert.equal(await waitForExecutionOrder(editor.notebook.uri, findFirstCodeCellIndex(editor.notebook)), 1);
    assert.equal(await waitForExecutionOrder(editor.notebook.uri, lastCellIndex), 2);

    await vscode.commands.executeCommand("rmdNotebooks.restartSession");

    // Re-run only the last cell. The counter lives on the R session, so a restart
    // makes a fresh session that starts over: this run is [1], not [3]. Wait past the
    // stale [2] still showing from before the restart so the assertion is meaningful.
    editor.selection = singleCellRange(lastCellIndex);
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");
    const resetOrder = await waitFor(() => {
      const notebook = vscode.workspace.notebookDocuments.find(
        (candidate) => candidate.uri.toString() === editor.notebook.uri.toString()
      );
      const order = notebook?.cellAt(lastCellIndex).executionSummary?.executionOrder;
      return order === undefined || order === 2 ? undefined : order;
    }, 15000);
    assert.equal(resetOrder, 1, `Expected the execution count to reset to [1] after a restart, got [${resetOrder}].`);
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

  it("keeps the inline R session alive after an execution timeout", async () => {
    await writeFixture(
      "timeout-preserves-session.qmd",
      [
        "# Timeout preserves session",
        "",
        "```{r waiting}",
        "x <- 42",
        "Sys.sleep(2)",
        "```",
        "",
        "```{r check}",
        "cat(sprintf('x=%s\\n', x))",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 1000);
    await updateTestSetting("execution.interactiveFallbackBehavior", "error");

    const editor = await openNotebookEditor("timeout-preserves-session.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "error")
    );

    await sleep(1000);

    editor.selection = singleCellRange(findLastCodeCellIndex(editor.notebook));
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    assert.ok(state.outputChannelText.includes("x=42"));
    assert.equal(vscode.window.terminals.length, 0);
  });

  it("times out starting the inline R session when the startup budget is too low", async () => {
    await writeFixture(".Rprofile", "Sys.sleep(3)\n");
    await writeFixture(
      "startup-timeout.qmd",
      [
        "# Startup timeout",
        "",
        "```{r probe}",
        "1 + 1",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("r.startupTimeoutMs", 1000);

    const editor = await openNotebookEditor("startup-timeout.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "error")
    );

    assert.ok(state.outputs.some((record) => record.status === "error"));
    assert.match(state.outputChannelText, /Timed out starting R session/);
  });

  it("starts a fresh inline R session after a startup timeout instead of caching the failure", async () => {
    await writeFixture(".Rprofile", "Sys.sleep(3)\n");
    await writeFixture(
      "startup-eviction.qmd",
      [
        "# Startup eviction",
        "",
        "```{r probe}",
        "1 + 1",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("startup-eviction.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    // First run: an undersized budget makes startup time out.
    await updateTestSetting("r.startupTimeoutMs", 1000);
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "error")
    );

    // Raise the budget and re-run without "Restart R Session": the failed session
    // must be evicted so a fresh one starts and succeeds.
    await updateTestSetting("r.startupTimeoutMs", 30000);
    await sleep(200);
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    assert.ok(state.outputs.some((record) => record.status === "success"));
    assert.match(state.outputChannelText, /\[1\] 2/);
  });

  it("stops run-all after redirecting an interactive chunk to the R terminal", async () => {
    await writeFixture(
      "interactive-run-all.qmd",
      [
        "# Interactive run all",
        "",
        "```{r waiting}",
        "Sys.sleep(2)",
        "```",
        "",
        "```{r later}",
        "cat('after redirect\\n')",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 1000);
    await updateTestSetting("execution.interactiveFallbackBehavior", "terminal");

    const editor = await openNotebookEditor("interactive-run-all.qmd");

    await vscode.commands.executeCommand("rmdNotebooks.runAllChunks");

    await waitFor(() => {
      const terminal = vscode.window.terminals.find((candidate) => candidate.name === "Rmd Notebooks R");
      return terminal ?? undefined;
    }, 15000);

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "redirected")
    );

    assert.equal(state.outputs.length, 1);
    assert.equal(state.outputs[0].status, "redirected");
    assert.ok(!state.outputChannelText.includes("after redirect"));
  });

  it("preserves protocol marker text in stdout", async () => {
    await writeFixture(
      "protocol-markers.qmd",
      [
        "# Protocol markers",
        "",
        "```{r markers}",
        "cat('SECTION:HTML:COUNT:1\\n')",
        "cat('RMD_NOTEBOOKS_END\\n')",
        "cat('LINE:%2Ftmp%2Fplot.png\\n')",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("protocol-markers.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    assert.ok(state.outputChannelText.includes("SECTION:HTML:COUNT:1"));
    assert.ok(state.outputChannelText.includes("RMD_NOTEBOOKS_END"));
    assert.ok(
      state.outputChannelText.includes("LINE:%2Ftmp%2Fplot.png") ||
      state.outputChannelText.includes("LINE:/tmp/plot.png")
    );
  });

  it("handles menu() prompts inline with a selection picker", async () => {
    await writeFixture(
      "interactive-menu.qmd",
      [
        "# Interactive menu",
        "",
        "```{r chooser}",
        "selection <- menu(c('alpha', 'beta'), title = 'Choose a package')",
        "cat(sprintf('selection=%s\\n', selection))",
        "```",
        ""
      ].join("\n")
    );

    extensionApi.setTestPromptResponses([{ value: "2" }]);

    const editor = await openNotebookEditor("interactive-menu.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) =>
        output.items.some((item) => item.mime === "application/vnd.code.notebook.stdout")
      )
    );

    const promptRequests = extensionApi.takeTestPromptRequests();
    assert.ok(promptRequests.some((request) => request.kind === "select" && request.prompt.includes("Choose a package")));
    assert.ok(promptRequests.some((request) => request.choices?.some((choice) => choice.label === "beta" && choice.value === "2")));
    assert.ok(state.outputChannelText.includes("selection=2"));
    assert.ok(
      renderedCell.outputs.some((output) =>
        output.items.some((item) => Buffer.from(item.data).toString("utf8").includes("selection=2"))
      )
    );
    assert.equal(vscode.window.terminals.length, 0);
  });

  it("queues a chunk requested while another is still running", async () => {
    await writeFixture(
      "queue-order.qmd",
      [
        "# Queue order",
        "",
        "```{r slow}",
        "Sys.sleep(2)",
        "cat('first done\\n')",
        "```",
        "",
        "```{r fast}",
        "cat('second done\\n')",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("queue-order.qmd");
    const uri = editor.notebook.uri.toString();
    const before = await extensionApi.getDocumentState(uri);
    const [slowId, fastId] = before.snapshot?.chunkIds ?? [];
    assert.ok(slowId && fastId, "Expected two chunk ids.");

    // Start the slow chunk and wait until it is actually executing.
    const slowRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, slowId);
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === slowId && record.status === "running")
    );

    // Requesting the second chunk while the first is busy should queue it, not error out.
    const fastRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, fastId);
    await Promise.all([slowRun, fastRun]);

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.filter((record) => record.status === "success").length === 2
    );

    assert.equal(state.outputs.filter((record) => record.status === "success").length, 2);
    assert.ok(!state.outputChannelText.includes("already executing"), "The queued chunk should not be rejected.");
    const firstIndex = state.outputChannelText.indexOf("first done");
    const secondIndex = state.outputChannelText.indexOf("second done");
    assert.ok(firstIndex >= 0 && secondIndex >= 0, "Both chunks should have produced stdout.");
    assert.ok(firstIndex < secondIndex, "The queued chunk should run after the one already executing.");
  });

  it("preserves request order for back-to-back dependent chunks", async () => {
    // Repeat across fresh sessions so the regression remains reliable without
    // adding a long-running stress test to every integration-suite run.
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const name = `queue-dependent-chain-${iteration}.qmd`;
      await writeFixture(
        name,
        [
          `# Dependent queue chain ${iteration}`,
          "",
          "```{r a}",
          "queue_a <- 1",
          "```",
          "",
          "```{r b}",
          "queue_b <- queue_a",
          "```",
          "",
          "```{r c}",
          "queue_c <- queue_b",
          "```",
          "",
          "```{r d}",
          "queue_d <- queue_c",
          "```",
          "",
          "```{r e}",
          "queue_e <- queue_d",
          "```",
          "",
          "```{r result}",
          `cat("dependent-chain-${iteration}:", queue_e, "\\n")`,
          "```",
          ""
        ].join("\n")
      );

      const editor = await openNotebookEditor(name);
      const uri = editor.notebook.uri.toString();
      const before = await extensionApi.getDocumentState(uri);
      const chunkIds = before.snapshot?.chunkIds ?? [];
      assert.equal(chunkIds.length, 6, `Expected six dependent chunk ids in iteration ${iteration}.`);

      // Model rapid individual cell execution, not Run All's explicitly sequential
      // loop: each request is issued 100ms after the previous request without waiting
      // for the previous chunk to finish.
      const runs: Thenable<unknown>[] = [];
      for (const chunkId of chunkIds) {
        runs.push(vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, chunkId));
        await sleep(100);
      }
      await Promise.all(runs);

      const state = await extensionApi.getDocumentState(uri);
      assert.equal(
        state.outputs.filter((record) => record.status === "success").length,
        chunkIds.length,
        `Every dependent chunk should execute in requested order in iteration ${iteration}. ${state.outputChannelText}`
      );
      assert.ok(state.outputChannelText.includes(`dependent-chain-${iteration}: 1`));
      await closeAllEditors();
    }
  });

  it("stops the whole run, interrupting the running chunk and cancelling the queued ones", async () => {
    await writeFixture(
      "queue-interrupt.qmd",
      [
        "# Queue interrupt",
        "",
        "```{r blocking}",
        "Sys.sleep(30)",
        "cat('blocking done\\n')",
        "```",
        "",
        "```{r waiting}",
        "cat('waiting done\\n')",
        "```",
        ""
      ].join("\n")
    );

    // Keep the interactive timeout out of the way: the chunk is meant to be
    // stopped by the interrupt, not by the fallback.
    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 60000);

    const editor = await openNotebookEditor("queue-interrupt.qmd");
    const uri = editor.notebook.uri.toString();
    const before = await extensionApi.getDocumentState(uri);
    const [blockingId, waitingId] = before.snapshot?.chunkIds ?? [];
    assert.ok(blockingId && waitingId, "Expected two chunk ids.");

    const blockingRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, blockingId);
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === blockingId && record.status === "running")
    );

    const waitingRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, waitingId);
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === waitingId && record.status === "running")
    );
    // Give the queued chunk a moment to actually enter the session queue before
    // interrupting, so the interrupt is guaranteed to catch it waiting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await vscode.commands.executeCommand("rmdNotebooks.interruptSession", uri);
    await Promise.all([blockingRun, waitingRun]);

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) => {
      const blocking = candidate.outputs.find((record) => record.chunkId === blockingId);
      const waiting = candidate.outputs.find((record) => record.chunkId === waitingId);
      return blocking?.status === "error" && waiting?.status === "cancelled";
    });

    const blocking = state.outputs.find((record) => record.chunkId === blockingId);
    const waiting = state.outputs.find((record) => record.chunkId === waitingId);
    assert.equal(blocking?.status, "error");
    assert.equal(waiting?.status, "cancelled");
    assert.ok(!state.outputChannelText.includes("blocking done"), "The interrupted chunk should not finish.");
    assert.ok(!state.outputChannelText.includes("waiting done"), "The cancelled chunk should never run.");
  });

  it("stops a Run All in progress so the remaining chunks do not run", async () => {
    await writeFixture(
      "runall-stop.qmd",
      [
        "# Run all stop",
        "",
        "```{r warm}",
        "1 + 1",
        "```",
        "",
        "```{r slow}",
        "Sys.sleep(10)",
        "cat('runall-slow done\\n')",
        "```",
        "",
        "```{r mid}",
        "cat('runall-mid done\\n')",
        "```",
        "",
        "```{r tail}",
        "cat('runall-tail done\\n')",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 60000);

    const editor = await openNotebookEditor("runall-stop.qmd");
    const uri = editor.notebook.uri;
    const before = await extensionApi.getDocumentState(uri.toString());
    const [, slowId, midId, tailId] = before.snapshot?.chunkIds ?? [];
    assert.ok(slowId && midId && tailId, "Expected four chunk ids.");

    // Run every chunk. The warm-up chunk runs first (so the session is ready by the
    // time the slow chunk starts), then the slow Sys.sleep(10) chunk runs while mid and
    // tail wait their turn in the run loop.
    const runAll = vscode.commands.executeCommand("rmdNotebooks.runAllChunks", uri.toString());
    await waitForDocumentState(uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === slowId && record.status === "running")
    );
    await sleep(400);

    // Stop All during a Run All must end the WHOLE run, not just interrupt the current
    // cell and let the loop march on to the next one.
    await vscode.commands.executeCommand("rmdNotebooks.interruptSession", uri.toString());
    await runAll;

    const state = await waitForDocumentState(
      uri,
      (candidate) => {
        const slow = candidate.outputs.find((record) => record.chunkId === slowId);
        return !!slow && slow.status !== "running";
      },
      15000
    );

    const slow = state.outputs.find((record) => record.chunkId === slowId);
    assert.ok(slow && slow.status !== "success", `The interrupted chunk should not complete, got ${slow?.status}.`);
    assert.ok(!state.outputChannelText.includes("runall-slow done"), "The interrupted chunk should not finish.");
    assert.ok(!state.outputChannelText.includes("runall-mid done"), "Run All must not continue to the next chunk after Stop All.");
    assert.ok(!state.outputChannelText.includes("runall-tail done"), "Run All must not continue to later chunks after Stop All.");
  });

  it("cancels only the targeted queued chunk and lets the others run", async () => {
    await writeFixture(
      "cancel-one.qmd",
      [
        "# Cancel one",
        "",
        "```{r runningchunk}",
        "Sys.sleep(3)",
        "cat('running done\\n')",
        "```",
        "",
        "```{r cancelme}",
        "cat('cancelme done\\n')",
        "```",
        "",
        "```{r survivor}",
        "cat('survivor done\\n')",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 60000);

    const editor = await openNotebookEditor("cancel-one.qmd");
    const uri = editor.notebook.uri;
    const before = await extensionApi.getDocumentState(uri.toString());
    const [runningId, cancelId, survivorId] = before.snapshot?.chunkIds ?? [];
    assert.ok(runningId && cancelId && survivorId, "Expected three chunk ids.");

    const cancelIndex = findCodeCellIndex(editor.notebook, "cancelme done");

    // Queue all three: the first runs (~3s), the other two wait behind it.
    const runningRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), runningId);
    await waitForDocumentState(uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === runningId && record.status === "running")
    );
    const cancelRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), cancelId);
    const survivorRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), survivorId);
    await waitForDocumentState(uri, (candidate) =>
      [cancelId, survivorId].every((id) => candidate.outputs.some((record) => record.chunkId === id))
    );
    // Let the two trailing chunks settle into the session queue behind the running one.
    await sleep(300);

    // Stop just the middle chunk from its own cell, the way its stop button would.
    editor.selection = singleCellRange(cancelIndex);
    await vscode.commands.executeCommand("notebook.cell.cancelExecution");

    await Promise.all([runningRun, cancelRun, survivorRun]);

    const state = await waitForDocumentState(uri, (candidate) => {
      const running = candidate.outputs.find((record) => record.chunkId === runningId);
      const cancelled = candidate.outputs.find((record) => record.chunkId === cancelId);
      const survivor = candidate.outputs.find((record) => record.chunkId === survivorId);
      return running?.status === "success" && cancelled?.status === "cancelled" && survivor?.status === "success";
    });

    assert.equal(state.outputs.find((record) => record.chunkId === cancelId)?.status, "cancelled");
    assert.equal(state.outputs.find((record) => record.chunkId === runningId)?.status, "success");
    assert.equal(state.outputs.find((record) => record.chunkId === survivorId)?.status, "success");
    assert.ok(state.outputChannelText.includes("running done"), "The running chunk should finish.");
    assert.ok(state.outputChannelText.includes("survivor done"), "The chunk after the cancelled one should run.");
    assert.ok(!state.outputChannelText.includes("cancelme done"), "The cancelled chunk should never run.");
  });

  it("interrupts only the running cell and lets the queue continue", async () => {
    await writeFixture(
      "cancel-running.qmd",
      [
        "# Cancel running",
        "",
        "```{r warmup}",
        "1 + 1",
        "```",
        "",
        "```{r runningchunk}",
        "Sys.sleep(30)",
        "cat('running-cell finished\\n')",
        "```",
        "",
        "```{r nextchunk}",
        "cat('after-interrupt ran\\n')",
        "```",
        ""
      ].join("\n")
    );

    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 60000);

    const editor = await openNotebookEditor("cancel-running.qmd");
    const uri = editor.notebook.uri;
    const before = await extensionApi.getDocumentState(uri.toString());
    const [warmupId, runningId, nextId] = before.snapshot?.chunkIds ?? [];
    assert.ok(warmupId && runningId && nextId, "Expected three chunk ids.");

    const runningIndex = findCodeCellIndex(editor.notebook, "running-cell finished");

    // Warm the session so the long chunk begins running within microseconds of being
    // enqueued; otherwise it could still be queued when we cancel and get dropped
    // (cancelled) instead of interrupted (error).
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), warmupId);
    await waitForDocumentState(uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === warmupId && record.status === "success")
    );

    // Start the long chunk, then queue another behind it.
    const runningRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), runningId);
    await waitForDocumentState(uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === runningId && record.status === "running")
    );
    const nextRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), nextId);
    await waitForDocumentState(uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === nextId)
    );
    // Let the long chunk actually begin in R and the next one settle in the queue.
    await sleep(400);

    // Stop just the running cell from its own stop button: it should be interrupted
    // while the queued chunk behind it keeps going.
    editor.selection = singleCellRange(runningIndex);
    await vscode.commands.executeCommand("notebook.cell.cancelExecution");

    await Promise.all([runningRun, nextRun]);

    const state = await waitForDocumentState(uri, (candidate) => {
      const running = candidate.outputs.find((record) => record.chunkId === runningId);
      const next = candidate.outputs.find((record) => record.chunkId === nextId);
      return running?.status === "error" && next?.status === "success";
    });

    assert.equal(
      state.outputs.find((record) => record.chunkId === runningId)?.status,
      "error",
      "The running cell should be interrupted."
    );
    assert.equal(
      state.outputs.find((record) => record.chunkId === nextId)?.status,
      "success",
      "The queued cell should still run after the running one is interrupted."
    );
    assert.ok(!state.outputChannelText.includes("running-cell finished"), "The interrupted cell should not finish.");
    assert.ok(state.outputChannelText.includes("after-interrupt ran"), "The queue should continue after the interrupt.");
  });

  it("times each queued chunk by its own run, not the time since the first one started", async () => {
    await writeFixture(
      "queue-timing.qmd",
      [
        "# Queue timing",
        "",
        "```{r firstsleep}",
        "Sys.sleep(1)",
        "```",
        "",
        "```{r secondsleep}",
        "Sys.sleep(1)",
        "```",
        ""
      ].join("\n")
    );

    const editor = await openNotebookEditor("queue-timing.qmd");
    const uri = editor.notebook.uri.toString();
    const before = await extensionApi.getDocumentState(uri);
    const [firstId, secondId] = before.snapshot?.chunkIds ?? [];
    assert.ok(firstId && secondId, "Expected two chunk ids.");

    const firstIndex = findFirstCodeCellIndex(editor.notebook);
    const secondIndex = findLastCodeCellIndex(editor.notebook);

    // Queue both chunks back-to-back so the second waits behind the first, just like
    // running two cells in quick succession.
    const firstRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, firstId);
    const secondRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, secondId);
    await Promise.all([firstRun, secondRun]);

    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.filter((record) => record.status === "success").length === 2
    );

    const firstTiming = await waitForCellTiming(editor.notebook.uri, firstIndex);
    const secondTiming = await waitForCellTiming(editor.notebook.uri, secondIndex);

    const firstDuration = firstTiming.endTime - firstTiming.startTime;
    const secondDuration = secondTiming.endTime - secondTiming.startTime;

    // Each cell should report roughly its own ~1s sleep. Before the fix the second
    // cell's clock started when it was enqueued (alongside the first), so it reported
    // ~2s (the elapsed time since the first chunk began) instead of its own ~1s.
    assert.ok(
      firstDuration < 1800,
      `First chunk should report ~its own 1s run, got ${firstDuration}ms.`
    );
    assert.ok(
      secondDuration < 1800,
      `Second chunk should report ~its own 1s run, not the cumulative time, got ${secondDuration}ms.`
    );
    // The two chunks ran sequentially (the queued one only started once the running
    // one finished), confirming the clock reflects the queue wait rather than the
    // enqueue moment. Order-independent: the two un-awaited runs can enqueue in either
    // order, so compare the later start against the earlier end rather than assuming
    // which chunk ran first.
    const laterStart = Math.max(firstTiming.startTime, secondTiming.startTime);
    const earlierEnd = Math.min(firstTiming.endTime, secondTiming.endTime);
    assert.ok(
      laterStart >= earlierEnd - 250,
      `The second chunk should start when the first finished (later start ${laterStart}, earlier end ${earlierEnd}).`
    );
  });

  it("interrupts a running chunk even after an earlier interrupt in the same session", async () => {
    await writeFixture(
      "double-interrupt.qmd",
      [
        "# Double interrupt",
        "",
        "```{r warmup}",
        "1 + 1",
        "```",
        "",
        "```{r blockingone}",
        "Sys.sleep(10)",
        "```",
        "",
        "```{r blockingtwo}",
        "Sys.sleep(10)",
        "```",
        ""
      ].join("\n")
    );

    // Keep the interactive-fallback timeout out of the way so each chunk is stopped by
    // the interrupt, not by the timeout.
    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 60000);

    const editor = await openNotebookEditor("double-interrupt.qmd");
    const uri = editor.notebook.uri;
    const before = await extensionApi.getDocumentState(uri.toString());
    const [warmupId, firstId, secondId] = before.snapshot?.chunkIds ?? [];
    assert.ok(warmupId && firstId && secondId, "Expected three chunk ids.");

    // Warm the session up first so a queued chunk begins running within microseconds
    // of being enqueued, making the interrupt timing below deterministic.
    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), warmupId);
    await waitForDocumentState(uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === warmupId && record.status === "success")
    );

    // Interrupt the first chunk while it runs.
    await interruptRunningChunk(uri, firstId);

    // Interrupt a second chunk in the SAME session: this is the regression. Before the
    // fix the second SIGINT was skipped (child.killed stays true after the first kill,
    // even though the session survives it), so the chunk ran to completion instead of
    // stopping while the queued chunks still got cancelled.
    await interruptRunningChunk(uri, secondId);
  });

  it("runs a queued chunk after the one ahead of it times out", async () => {
    await writeFixture(
      "queue-after-timeout.qmd",
      [
        "# Queue after timeout",
        "",
        "```{r slow}",
        "x <- 42",
        "Sys.sleep(2)",
        "```",
        "",
        "```{r queued}",
        "cat(sprintf('queued ran x=%s\\n', x))",
        "```",
        ""
      ].join("\n")
    );

    // The chunk ahead hits the interactive-fallback timeout (reported as an error,
    // not redirected to a terminal). The queued chunk must not stay wedged behind
    // the abandoned execution: once the interrupted chunk emits RESULT_END the queue
    // drains and the queued chunk runs in the same still-live session.
    await updateTestSetting("execution.interactiveFallbackTimeoutMs", 1000);
    await updateTestSetting("execution.interactiveFallbackBehavior", "error");

    const editor = await openNotebookEditor("queue-after-timeout.qmd");
    const uri = editor.notebook.uri.toString();
    const before = await extensionApi.getDocumentState(uri);
    const [slowId, queuedId] = before.snapshot?.chunkIds ?? [];
    assert.ok(slowId && queuedId, "Expected two chunk ids.");

    // Start the slow chunk, wait until it is actually executing, then queue the
    // second one behind it before the timeout fires.
    const slowRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, slowId);
    await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.chunkId === slowId && record.status === "running")
    );

    const queuedRun = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri, queuedId);
    await Promise.all([slowRun, queuedRun]);

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) => {
      const slow = candidate.outputs.find((record) => record.chunkId === slowId);
      const queued = candidate.outputs.find((record) => record.chunkId === queuedId);
      return slow?.status === "error" && queued?.status === "success";
    });

    const slow = state.outputs.find((record) => record.chunkId === slowId);
    const queued = state.outputs.find((record) => record.chunkId === queuedId);
    assert.equal(slow?.status, "error", "The chunk ahead should hit the inline timeout.");
    assert.equal(queued?.status, "success", "The queued chunk should run after the timeout, not hang behind it.");
    assert.ok(
      state.outputChannelText.includes("queued ran x=42"),
      "The queued chunk should execute in the same live session."
    );
  });

  it("handles readline() prompts inline with a text input", async () => {
    await writeFixture(
      "interactive-readline.qmd",
      [
        "# Interactive readline",
        "",
        "```{r reader}",
        "value <- readline('Package name?')",
        "cat(sprintf('value=%s\\n', value))",
        "```",
        ""
      ].join("\n")
    );

    extensionApi.setTestPromptResponses([{ value: "dplyr" }]);

    const editor = await openNotebookEditor("interactive-readline.qmd");
    editor.selection = singleCellRange(findFirstCodeCellIndex(editor.notebook));

    await vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk");

    const state = await waitForDocumentState(editor.notebook.uri, (candidate) =>
      candidate.outputs.some((record) => record.status === "success" && record.outputTypes.includes("text"))
    );

    const codeCell = editor.notebook.cellAt(findFirstCodeCellIndex(editor.notebook));
    const renderedCell = await waitForNotebookOutput(codeCell, (cell) =>
      cell.outputs.some((output) =>
        output.items.some((item) => item.mime === "application/vnd.code.notebook.stdout")
      )
    );

    const promptRequests = extensionApi.takeTestPromptRequests();
    assert.ok(promptRequests.some((request) => request.kind === "input" && request.prompt.includes("Package name?")));
    assert.ok(state.outputChannelText.includes("value=dplyr"));
    assert.ok(
      renderedCell.outputs.some((output) =>
        output.items.some((item) => Buffer.from(item.data).toString("utf8").includes("value=dplyr"))
      )
    );
    assert.equal(vscode.window.terminals.length, 0);
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
  await deleteWorkspaceFile(".Rprofile");
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.files.saveAll");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => (vscode.window.visibleNotebookEditors.length === 0 && vscode.window.visibleTextEditors.length === 0 ? true : undefined),
    2000
  ).catch(() => undefined);
  await sleep(100);
}

async function writeFixture(name: string, contents: string): Promise<void> {
  await vscode.workspace.fs.writeFile(getWorkspaceFileUri(name), Buffer.from(contents, "utf8"));
}

async function deleteWorkspaceFile(name: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(getWorkspaceFileUri(name), { useTrash: false });
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError)) {
      throw error;
    }
  }
}

async function resetTestSettings(): Promise<void> {
  await updateTestSetting("r.args", undefined);
  await updateTestSetting("r.sourceVscodeRSessionWatcher", false);
  await updateTestSetting("r.startupTimeoutMs", undefined);
  await updateTestSetting("python.path", undefined);
  await updateTestSetting("python.args", undefined);
  await updateTestSetting("python.startupTimeoutMs", undefined);
  await updateTestSetting("execution.interactiveFallbackTimeoutMs", 0);
  await updateTestSetting("execution.interactiveFallbackBehavior", "prompt");
  await updateTestSetting("output.dataFrameRender", undefined);
  await updateTestSetting("output.dataFrameMaxRows", undefined);
  await updateTestSetting("output.dataFrameMaxColumns", undefined);
}

async function updateTestSetting(section: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration("rmdNotebooks").update(section, value, vscode.ConfigurationTarget.Workspace);
}

function getWorkspaceFileUri(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "A workspace folder should be available for integration tests.");
  return vscode.Uri.joinPath(folder.uri, name);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
  return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
}

function findFirstCodeCellIndex(notebook: vscode.NotebookDocument): number {
  const index = notebook.getCells().findIndex(isExecutableChunkCell);
  assert.ok(index >= 0, "A code cell should exist.");
  return index;
}

function findLastCodeCellIndex(notebook: vscode.NotebookDocument): number {
  const cells = notebook.getCells();
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (isExecutableChunkCell(cells[index])) {
      return index;
    }
  }

  throw new Error("A code cell should exist.");
}

function findCodeCellIndex(notebook: vscode.NotebookDocument, snippet: string): number {
  const index = notebook.getCells().findIndex(
    (cell) => isExecutableChunkCell(cell) && cell.document.getText().includes(snippet)
  );
  assert.ok(index >= 0, `Expected a code cell containing ${snippet}.`);
  return index;
}

function isExecutableChunkCell(cell: vscode.NotebookCell): boolean {
  return cell.kind === vscode.NotebookCellKind.Code && cell.metadata?.rmdNotebooks?.kind !== "frontmatter";
}

function singleCellRange(index: number): vscode.NotebookRange {
  return new vscode.NotebookRange(index, index + 1);
}

function notebookOutputText(cell: vscode.NotebookCell, mime: string): string {
  return cell.outputs
    .flatMap((output) => output.items)
    .filter((item) => item.mime === mime)
    .map((item) => Buffer.from(item.data).toString("utf8"))
    .join("\n");
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

async function interruptRunningChunk(uri: vscode.Uri, chunkId: string): Promise<void> {
  const run = vscode.commands.executeCommand("rmdNotebooks.runCurrentChunk", uri.toString(), chunkId);
  await waitForDocumentState(uri, (candidate) =>
    candidate.outputs.some((record) => record.chunkId === chunkId && record.status === "running")
  );
  // The "running" status is set just before the chunk is handed to R, so give it a
  // moment to actually begin executing; interrupting during that window would cancel
  // it (as still-queued) instead of interrupting the running chunk.
  await sleep(400);
  await vscode.commands.executeCommand("rmdNotebooks.interruptSession", uri.toString());

  // A working interrupt terminates the chunk (status "error") almost immediately.
  // Bound the wait and accept any terminal status so a regression (the SIGINT is
  // skipped and the chunk runs to completion -> "success") fails fast with a targeted
  // assertion instead of via the 60s mocha timeout.
  const state = await waitForDocumentState(
    uri,
    (candidate) => {
      const record = candidate.outputs.find((entry) => entry.chunkId === chunkId);
      return !!record && (record.status === "error" || record.status === "success" || record.status === "cancelled");
    },
    15000
  );
  const record = state.outputs.find((entry) => entry.chunkId === chunkId);
  assert.equal(record?.status, "error", `Chunk ${chunkId} should be interrupted (status error), got ${record?.status}.`);
  await run.then(undefined, () => undefined);
}

async function waitForExecutionOrder(
  uri: vscode.Uri,
  cellIndex: number,
  timeoutMs = 30000
): Promise<number> {
  return waitFor(() => {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    return notebook?.cellAt(cellIndex).executionSummary?.executionOrder;
  }, timeoutMs);
}

async function waitForCellTiming(
  uri: vscode.Uri,
  cellIndex: number,
  timeoutMs = 30000
): Promise<{ startTime: number; endTime: number }> {
  return waitFor(() => {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    const timing = notebook?.cellAt(cellIndex).executionSummary?.timing;
    return timing && timing.endTime >= timing.startTime ? timing : undefined;
  }, timeoutMs);
}

async function waitForDocumentState(
  uri: vscode.Uri,
  predicate: (state: Awaited<ReturnType<InlineChunksExtensionApi["getDocumentState"]>>) => boolean,
  timeoutMs = 30000
): Promise<Awaited<ReturnType<InlineChunksExtensionApi["getDocumentState"]>>> {
  return waitFor(async () => {
    const state = await extensionApi.getDocumentState(uri.toString());
    return predicate(state) ? state : undefined;
  }, timeoutMs);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
