import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import * as vscode from "vscode";
import { PythonEnvironmentApi, PythonEnvironments } from "@vscode/python-environments";
import { InlineChunksNotebookRuntime } from "../../../src/notebook/notebookRuntime";
import { PythonEnvironmentDiscovery } from "../../../src/integration/pythonEnvironmentDiscovery";
import { PythonLaunchDescriptor } from "../../../src/execution/pythonRuntimeTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const runtimeA: PythonLaunchDescriptor = {
  id: "environment:a", environmentId: "environment:a", source: "environment",
  label: "A", executable: "/a/python", renderPythonPath: "/a/python", prefixArgs: []
};
const runtimeB: PythonLaunchDescriptor = { ...runtimeA, id: "environment:b", environmentId: "environment:b", label: "B", executable: "/b/python", renderPythonPath: "/b/python" };

// Test the real transition methods with controllable provider/storage boundaries.
// No processes or notebook controllers are needed for these race regressions.
function selectionHarness() {
  const runtime = Object.create(InlineChunksNotebookRuntime.prototype);
  const stored = new Map();
  let selected: { id: string; path: string; environmentVariables?: Record<string, string> } | undefined;
  Object.assign(runtime, {
    selectionRevisions: new Map(), selectionUpdates: new Map(), effectivePythonRuntimes: new Map(),
    selectedControllers: new Map(),
    workspaceState: { get: (key: string) => stored.get(key), update: async (key: string, value: unknown) => { stored.set(key, value); } },
    pythonExecutor: {
      getSelectedInterpreter: () => selected,
      selectInterpreter: async (_key: string, value: typeof selected) => { selected = value; }
    },
    pythonDiscovery: {
      ensureInitialized: async () => {}, getRuntimes: () => [runtimeA, runtimeB],
      getActiveEnvironmentId: async () => runtimeA.id,
      getEnvironmentVariables: async () => ({ PROJECT_SECRET: "test-only" })
    },
    registerPythonController: () => ({}), updatePythonEnvironmentStatus: () => {}
  });
  const notebook = { uri: vscode.Uri.parse("untitled:selection-regression.qmd"), isClosed: false };
  return { runtime, notebook, stored, selected: () => selected };
}

describe("Python selection regressions", () => {
  it("accepts newly discovered picker entries while initialization is still pending", async () => {
    const h = selectionHarness();
    const initialized = deferred<void>();
    const entered = deferred<void>();
    const changes = new vscode.EventEmitter<void>();
    h.runtime.resolveNotebook = () => h.notebook;
    h.runtime.pythonDiscovery.ensureInitialized = () => { entered.resolve(); return initialized.promise; };
    h.runtime.pythonDiscovery.getRuntimes = () => [];
    h.runtime.pythonDiscovery.getState = () => ({ initialized: false, environments: 0 });
    h.runtime.pythonDiscovery.onDidChangeRuntimes = changes.event;
    const selector = h.runtime.selectPythonEnvironment();
    try {
      await entered.promise;
      h.runtime.pythonDiscovery.getRuntimes = () => [runtimeB];
      changes.fire();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vscode.commands.executeCommand("type", { text: "B" });
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      await selector;
      assert.equal(h.selected()?.id, runtimeB.id);
    } finally {
      initialized.resolve();
      changes.dispose();
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    }
  });

  it("does not persist automatic selection and follows workspace changes", async () => {
    const h = selectionHarness();
    await h.runtime.ensurePythonRuntimeSelected(h.notebook);
    assert.equal(h.selected()?.id, runtimeA.id);
    assert.equal(h.stored.size, 0);
    h.runtime.pythonDiscovery.getActiveEnvironmentId = async () => runtimeB.id;
    await h.runtime.ensurePythonRuntimeSelected(h.notebook);
    assert.equal(h.selected()?.id, runtimeB.id);
  });

  it("keeps an explicit choice made during automatic lookup", async () => {
    const h = selectionHarness();
    const lookup = deferred<string>();
    const entered = deferred<void>();
    h.runtime.pythonDiscovery.getActiveEnvironmentId = () => { entered.resolve(); return lookup.promise; };
    const automatic = h.runtime.ensurePythonRuntimeSelected(h.notebook);
    await entered.promise;
    await h.runtime.selectPythonRuntime(h.notebook, runtimeB);
    lookup.resolve(runtimeA.id);
    await automatic;
    assert.equal(h.selected()?.id, runtimeB.id);
    assert.equal(h.selected()?.environmentVariables?.PROJECT_SECRET, "test-only");
    assert.ok(!JSON.stringify([...h.stored.values()]).includes("test-only"));
  });

  it("reset-to-automatic removes the override", async () => {
    const h = selectionHarness();
    await h.runtime.selectPythonRuntime(h.notebook, runtimeB);
    await h.runtime.selectPythonRuntime(h.notebook, undefined);
    await h.runtime.ensurePythonRuntimeSelected(h.notebook);
    assert.equal(h.selected()?.id, runtimeA.id);
    assert.ok([...h.stored.values()].every((value) => value === undefined));
  });

  it("rejects a removed explicit environment instead of using its stale executable", async () => {
    const h = selectionHarness();
    await h.runtime.selectPythonRuntime(h.notebook, runtimeB);
    h.runtime.pythonDiscovery.getRuntimes = () => [runtimeA];
    await assert.rejects(h.runtime.ensurePythonRuntimeSelected(h.notebook), /no longer available/);
  });

  it("does not apply a cancelled discovery result", async () => {
    const h = selectionHarness();
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    await assert.rejects(h.runtime.ensurePythonRuntimeSelected(h.notebook, cancellation.token), /cancel/i);
    assert.equal(h.selected(), undefined);
    cancellation.dispose();
  });

  it("keeps healthy environments when one resolution fails and retains the catalog on scan failure", async () => {
    const discovery = new PythonEnvironmentDiscovery();
    const healthy = {
      envId: { managerId: "test", id: "healthy" }, environmentPath: vscode.Uri.file("/healthy"),
      displayName: "Healthy", name: "healthy", execInfo: { run: { executable: "/healthy/python" } }
    };
    const broken = { ...healthy, environmentPath: vscode.Uri.file("/broken") };
    const api = {
      getEnvironments: async () => [healthy, broken],
      resolveEnvironment: async (uri: vscode.Uri) => { if (uri.fsPath === "/broken") throw new Error("broken"); return healthy; }
    };
    Object.assign(discovery, { api, initializationPromise: Promise.resolve() });
    try {
      await discovery.refresh();
      assert.equal(discovery.getState().environments, 1);
      assert.match(discovery.getState().error ?? "", /1 Python environment/);
      api.getEnvironments = async () => { throw new Error("scan failed"); };
      await discovery.refresh();
      assert.equal(discovery.getState().environments, 1);
      assert.ok(discovery.getRuntimes().some((entry) => entry.label === "Healthy"));
    } finally { discovery.dispose(); }
  });

  it("retries failed provider initialization and requests document-scoped environment variables", async () => {
    const original = PythonEnvironments.api;
    const discovery = new PythonEnvironmentDiscovery();
    const changes = new vscode.EventEmitter<void>();
    const resource = vscode.Uri.parse("untitled:scoped-python.qmd");
    let requestedResource: vscode.Uri | undefined;
    try {
      PythonEnvironments.api = async () => { throw new Error("provider unavailable"); };
      await discovery.ensureInitialized();
      assert.equal(discovery.getState().available, false);
      PythonEnvironments.api = async () => ({
        onDidChangeEnvironments: changes.event, onDidChangeEnvironment: changes.event,
        getEnvironments: async () => [],
        getEnvironmentVariables: async (uri: vscode.Uri) => { requestedResource = uri; return { PROJECT_VALUE: "scoped" }; }
      } as unknown as PythonEnvironmentApi);
      await discovery.refresh();
      assert.equal(discovery.getState().available, true);
      assert.deepEqual(await discovery.getEnvironmentVariables(resource), { PROJECT_VALUE: "scoped" });
      assert.equal(requestedResource?.toString(), resource.toString());
    } finally {
      PythonEnvironments.api = original;
      changes.dispose();
      discovery.dispose();
    }
  });

  for (const failure of ["lookup", "cancellation", "stop-all", "persistence"]) {
    it(`finalizes cell execution after preparation ${failure}`, async () => {
      const h = selectionHarness();
      const cancellation = new vscode.CancellationTokenSource();
      const preparing = deferred<void>();
      let ended = 0;
      let launched = false;
      let released = false;
      const execution = {
        token: cancellation.token, start() {}, end() { ended += 1; },
        async clearOutput() {}, async replaceOutput() {}
      };
      const cell = { index: 0, metadata: {}, document: { getText: () => "print(42)", languageId: "python" } };
      const notebook = { ...h.notebook, cellAt: () => cell };
      Object.assign(h.runtime, {
        preparingExecutions: new Map(), outputSyncInFlight: new Set(),
        interruptionRevisions: new Map(), runsToAbort: new Set(), resolveNotebook: () => notebook,
        refreshNotebook: async () => ({ chunks: [{ index: 0, cell, sourceKind: "chunk", chunk: {
          documentUri: notebook.uri.toString(), language: "python", identity: { chunkId: "test" }
        } }] }),
        ensureOutputsLoaded: async () => new Map(),
        ensureControllerSelected: async () => ({ createNotebookCellExecution: () => execution }),
        outputStore: { saveDocumentOutputs: async () => { if (failure === "persistence") throw new Error("disk failure"); } },
        outputChannelController: { logRunCompleted() {} },
        executorRegistry: { get: () => ({ executeChunk() { launched = true; } }), all: () => [] },
        ensurePythonRuntimeSelected: async () => {
          preparing.resolve();
          if (failure === "cancellation" || failure === "stop-all") await new Promise(() => {});
          throw new Error("lookup failed");
        }
      });
      try {
        const result = h.runtime.executeAdmittedCell(notebook, cell, () => { released = true; });
        await preparing.promise;
        if (failure === "cancellation") cancellation.cancel();
        if (failure === "stop-all") await h.runtime.interruptSession();
        if (failure === "persistence") await assert.rejects(result, /disk failure/);
        else await result;
        assert.equal(ended, 1);
        assert.equal(launched, false);
        assert.equal(released, true);
        assert.equal(h.runtime.preparingExecutions.size, 0);
      } finally { cancellation.dispose(); }
    });
  }
});
