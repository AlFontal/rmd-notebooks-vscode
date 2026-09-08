# Python environment selection audit

Reviewed 2026-09-08 against v0.6.0 / b7c22c4. Scope: environment discovery, notebook kernel selection, interpreter persistence, session transitions, and test coverage. Findings and line numbers below describe the audited release, not the subsequent implementation.

## Implementation follow-up

The working tree now implements the eight fixes: environment-backed native controllers; a live, nonblocking command picker with manual and Automatic actions; bounded discovery and cancellation-aware execution cleanup; serialized, revision-checked selection; explicit-only persistence with catalog identity resolution; partial discovery recovery and retry; document-scoped environment variables and effective-runtime status; and dead-session eviction/recovery.

Legacy configured/PATH fallback pins are ignored. Legacy environment/manual choices remain preserved because v0.6.0 did not record whether an environment choice was automatic or explicit; users can remove those overrides with Automatic. Native controllers continue routing R cells to R and Python cells to embedded IPython. This does not implement Jupyter kernelspecs, widgets, or comm channels.

New regressions cover a second real virtual environment selected through VS Code's native kernel command, built-in Run Cell/Run All, process crash recovery, automatic/explicit selection races, reset-to-automatic, removed environments, partial discovery failure, picker acceptance during pending discovery, and execution finalization on lookup/cancellation/storage failure. The native-command test verifies controller wiring, not visual navigation through every level of VS Code's kernel menu. Windows execution and real Quarto preview remain outside the locally verified macOS host coverage.

Final verification: **62 unit tests and 71 extension-host tests passed**, using stable VS Code **1.136.1** on macOS arm64. The native-controller test includes mixed R/Python Run All and reopening the editor with the chosen interpreter. Provider retry, document-scoped variables, and Stop All during discovery have dedicated regressions.

An intermediate full run passed 68 tests and timed out in the previously intermittent Rmd stdout-rendering case; that case passed in a focused rerun. Test setup now avoids rewriting unchanged fixtures, which had triggered external-file reloads of retained notebook models. The subsequent full suite passed. This does not establish that every external-file reload race in production is resolved. The reopen test also accounts for VS Code retaining a hidden notebook document and its session after closing the editor.

## Findings and required changes

### 1. High: Python environments are absent from the notebook kernel picker

`src/notebook/notebookRuntime.ts:79` creates exactly one controller, labelled `Rmd Notebooks`. Discovered environments populate only a separate QuickPick. `ensureControllerSelected` at line 1368 repeatedly forces that controller through the internal `_notebook.selectKernel` command. Selecting a Python interpreter through the ordinary notebook kernel UI cannot select one of this extension's runtimes. This is an intentional design in the release, but it does not provide the expected kernel-selection workflow.

Required change: expose environment-backed controllers for this notebook type, with stable identities and useful environment labels/paths. Handle `onDidChangeSelectedNotebooks` to update the document's Python runtime and dispose its previous session. Preserve R routing for mixed notebooks. Use the selected controller for execution and restoration rather than forcing a singleton on every operation. Keep manual selection available when environment integration is absent.

Acceptance: open a Python QMD, choose environments A and B through the built-in picker, and verify different `sys.executable` values and a reset namespace. Run through the built-in cell and notebook commands.

### 2. High: discovery blocks the picker, including manual fallback

`selectPythonEnvironment` awaits `ensureInitialized()` at line 207 before creating or showing its QuickPick. Initialization awaits the catalog and resolution of every environment (`pythonEnvironmentDiscovery.ts:113`). There is no timeout or cancellation for this work. The picker takes a fixed catalog snapshot and never subscribes to catalog updates while open. The README claim that selection appears immediately is not met.

Required change: show cached/configured/manual choices immediately, discover in the background, update the visible list as results arrive, and display progress/errors without blocking interaction. Bound or cancel slow resolution and remove listeners when the picker closes. Avoid applying both custom filtering and VS Code's built-in filtering without testing multi-field queries.

Acceptance: a deliberately unresolved discovery promise must not prevent opening, cancelling, or using manual selection; newly discovered environments must appear in an already-open picker.

### 3. High: environment lookup failures leave cell executions unfinished

`executeAdmittedCell` creates a cell execution at line 778, then awaits runtime selection at line 817 outside the error handler beginning at line 844. `getActiveEnvironmentId` directly awaits the external API without handling rejection. A rejected lookup leaves the cell pending without calling `execution.end()`. Discovery delays also hold the execution-admission gate before an executor cancellation handler exists; Stop All does not cancel discovery.

Evidence: a controlled probe of the compiled runtime injected a rejected active-environment lookup. The error escaped the cell handler and the execution's `end()` was never called.

Required change: include selection/preparation inside execution cleanup, finalize every created execution on failure, and propagate cancellation through discovery and admission. Recheck cancellation before launching Python.

### 4. High: automatic selection can overwrite an explicit user choice

The guard at line 186 runs before the awaited `getActiveEnvironmentId` call at line 190. If the user selects B during that lookup, the automatic continuation still selects A at line 197. Selection also writes workspace state before updating the executor, so competing selection operations are not serialized.

Evidence: a deferred-lookup probe selected B while automatic lookup was waiting, then resolved A. The final interpreter was A.

Required change: track a per-document selection generation or serialize transitions. Revalidate after asynchronous work so an older automatic operation cannot replace a newer explicit choice. Commit persistence, session disposal, and displayed selection consistently.

### 5. Medium: automatic choices become permanent, stale overrides

`ensurePythonRuntimeSelected` uses the same persistence path for automatic and explicit choices (lines 197 and 295). On reopening, any saved descriptor bypasses discovery at line 176. Changes to the workspace interpreter or configured fallback therefore do not take effect, even when the user never explicitly pinned this document. The complete launch descriptor is reused without resolving its environment identity again. A moved/deleted environment stays selected. There is no reset-to-automatic action.

Evidence: a controlled probe automatically selected A, changed the workspace-active interpreter to B, cleared the live selection to simulate reopening, and still selected A.

Required change: distinguish automatic selection from explicit overrides, add reset-to-automatic, and resolve persisted environment identities against fresh catalog data. Validate manual paths and report unavailable environments with a recovery action. Preserve launch paths without dereferencing virtualenv symlinks.

### 6. Medium: one failed environment resolution discards the whole catalog

`pythonEnvironmentDiscovery.ts:123` uses `Promise.all`. A single rejection bypasses installation of every healthy result. The catch reports zero environments; after an earlier success it can instead leave old runtime entries while reporting zero. Initialization failure is cached permanently, so Refresh cannot reacquire an API that became available later. Environment-change events also trigger another global forced refresh rather than simply updating the catalog.

Evidence: a catalog probe supplied one valid environment and one rejected resolution. The resulting usable catalog was empty.

Required change: isolate per-environment failures, preserve usable entries, keep state counts accurate, retry failed initialization, and coalesce catalog updates without triggering redundant global scans.

### 7. Medium: selected-interpreter state is not a complete execution environment

The adapter only copies executable/arguments (`pythonEnvironmentDiscovery.ts:155`). It never calls the available `getEnvironmentVariables` API. Although descriptors and the executor support environment variables, production discovery never populates them. Project `.env` / `python.envFile` configuration therefore does not reach Python. The status bar reads the persisted descriptor and updates on editor/catalog changes, but not when the first Python cell is added or its language changes (`notebookRuntime.ts:143,655`).

Required change: obtain document-scoped environment variables at launch, avoid persisting their values, and derive UI state from the effective runtime. Refresh visibility on notebook cell/language changes. Test environment-manager launch arguments and Windows paths; direct-interpreter tests do not cover those cases.

### 8. Medium: process death is cached after successful startup

`pythonExecutor.ts:170` evicts sessions only when their readiness promise rejects. After readiness has resolved, `handleProcessFailure` at line 393 marks the session dead but leaves it in the executor map. Subsequent executions reuse it and fail with `Python session is no longer running` until restart or a different selection disposes it. Re-selecting the identical interpreter returns early at line 129 and does not recover it.

Required change: evict dead sessions through an explicit lifecycle callback, close process resources, and provide a clear restart action. Test unexpected exit after readiness and recovery, including selecting the same environment again.

## Runtime boundaries to make explicit

Python execution uses an embedded IPython shell, not a Jupyter kernel. `jupyter:` frontmatter does not determine interactive execution; it only suppresses preview alignment (`notebookRuntime.ts:285`). Environment-backed controllers can fix selection without replacing the execution protocol, but kernelspec support and matching Quarto preview execution require a separate runtime policy. Widgets and comm channels require additional implementation. The preview tests currently mock Quarto and do not establish that the real preview uses the selected interpreter.

## Test coverage and validation

- Unit suite: 58 passed after updating the test runner.
- Full extension-host suite: 57 passed on latest stable VS Code 1.136.1 (macOS arm64), using a fresh temporary IPython environment. No executable symlink workaround was needed with test-electron 3.1.0.
- Controlled probes reproduced the unfinished execution, selection race, persisted automatic choice, and all-or-nothing catalog failure described above. These used mocked integration boundaries, not a real environment manager failure.
- Existing Python host tests mostly use `selectTestPythonInterpreter` (`test/vscode/suite/extensionHost.test.ts:2346`) and custom execution commands. The discovery test opens and cancels the picker without accepting an environment. The interpreter-switch test uses the same executable with a different synthetic ID. These tests do not establish that ordinary kernel selection or switching between real environments works.
- Required regression coverage: actual picker acceptance, two distinct environments, delayed/failed discovery, selection races, reset-to-automatic, deleted environments, cancellation during selection, and built-in Run Cell / Run All.
- Earlier full run on VS Code 1.112: 56 passed, one Rmd output timeout accompanied by `model index out of range -1`; that case passed alone. This suggests an order-dependent lifecycle issue, but does not establish its cause or that Python introduced it.

The test runner now targets `stable` for both dependency installation and execution. `@vscode/test-electron` was updated from 2.5.2 to 3.1.0 to support the current macOS app executable. Its Node >=22 requirement matches CI. Python 3.12 in CI and the extension's minimum VS Code API requirement remain unchanged: these are separate from the pinned host version.
