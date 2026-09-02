<p align="center">
  <img src="./media/readme/logo.png" alt="Rmd Notebooks for VS Code logo" width="96" />
</p>

# Rmd Notebooks for VS Code

<p align="center">
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/AlFontal/rmd-notebooks-vscode/ci.yml?branch=main&label=ci" />
  <a href="https://marketplace.visualstudio.com/items?itemName=AlFontal.rmd-notebooks-vscode"><img alt="Install for VS Code" src="https://img.shields.io/badge/install-for%20VS%20Code-007ACC?logo=visualstudiocode&logoColor=white" /></a>
  <a href="https://open-vsx.org/extension/AlFontal/rmd-notebooks-vscode"><img alt="Install for Positron" src="https://img.shields.io/badge/install-for%20Positron-447099" /></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.110-007ACC?logo=visualstudiocode&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2E8B57" />
</p>

Run `.Rmd` and `.qmd` files as source-preserving notebooks in VS Code, with interactive R and Python execution, persisted outputs, plots, rich tables, and vscode-R workspace integration.

Rmd Notebooks opens R Markdown and Quarto documents as runnable notebooks without converting the file on disk. Code cells come from fenced chunks, outputs render inline, and the original source remains available whenever you want to inspect or edit it directly.

## Demo

<img src="./media/readme/demo.gif" alt="Rmd Notebooks for VS Code demo" width="1000" />

## Install

- VS Code: install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AlFontal.rmd-notebooks-vscode)
- Positron: install from [Open VSX](https://open-vsx.org/extension/AlFontal/rmd-notebooks-vscode)
- Manual: download the `.vsix` from the [GitHub releases page](https://github.com/AlFontal/rmd-notebooks-vscode/releases)

## Requirements

- VS Code-compatible editor API `^1.110.0`
- R available on your PATH, or configured with `rmdNotebooks.r.path`, for R chunks
- Python available on your PATH, or configured with `rmdNotebooks.python.path`, for Python chunks
- IPython in that Python environment for all Python chunk execution, including magics, top-level `await`, `display()`, and rich output

The VS Code Marketplace package installs the [vscode-R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) automatically for normal R tooling integration, including the R workspace viewer. The Open VSX package keeps vscode-R optional so Positron and other VS Code-compatible editors that provide their own R support can install Rmd Notebooks without an incompatible dependency.

## What It Does

- Opens `.Rmd`, `.rmd`, and `.qmd` files as notebooks
- Runs R and Python chunks in persistent per-document sessions, queueing rapid requests in execution order
- Uses IPython for magics, shell escapes, top-level `await`, ordered `display()` output, display updates, and registered rich formatters
- Discovers interpreters lazily from the global Python Environments catalog, including for standalone qmd files
- Evaluates inline chunks in `.GlobalEnv`, so user variables are normal R workspace variables
- Honors normal R startup files by default, including project `.Rprofile` files used by tools such as `renv`
- Shows inline stdout, stderr, HTML/Markdown representations, static PNG plots, and rich data-frame tables
- Evaluates native knitr and Quarto inline R expressions inside rendered prose cells
- Shows execution-order badges per notebook and language session, and resets them when sessions restart
- Persists outputs and restores them when the document is reopened
- Marks outputs stale after code edits
- Supports cancelling an individual running or queued cell, plus Stop All for the active notebook run
- Supports notebook commands for run current chunk, run all chunks, restart session, clear outputs, and source view
- Opens `.Rmd` HTML previews through vscode-R and `.qmd` previews through Quarto without leaving notebook view
- Supports chunk-header editing from notebook mode
- Handles common prompt-style interactions such as R `menu()`/`readline()` and Python `input()` with VS Code UI
- Lets unsupported interactive chunks fall back to an R terminal when the optional timeout is enabled

Python chunks use the selected interpreter directly and run from the source file's directory, so sibling imports and relative paths behave like Quarto. IPython is required; if it is missing, Rmd Notebooks offers to install it in the selected environment. Pandas, Matplotlib, Plotnine, and other libraries then render through their normal IPython formatters, preserving complete MIME bundles and output order.

## Python Environment Selection

Use **Rmd Notebooks: Select Python Environment** from the Command Palette or click the always-visible `Python: <environment>` status-bar control. Results appear immediately and fuzzy-match environment names, versions, managers, and paths. Rmd Notebooks automatically selects the file/workspace-active environment initially and remembers explicit choices per document.

The Marketplace package installs the Python Environments integration automatically. In hosts where it is unavailable, `rmdNotebooks.python.path`, `QUARTO_PYTHON`, manual selection, and the platform PATH fallback remain available. Changing environments disposes the old per-document Python session and starts a fresh session on the next run.

Rmd Notebooks does not rewrite `jupyter:` frontmatter or treat kernelspecs as execution environments. For a Python-only qmd file without an explicit `jupyter:` pin, extension-triggered Quarto previews receive the selected interpreter through a scoped `QUARTO_PYTHON` override. Mixed R/Python documents and explicitly pinned documents remain under Quarto's own runtime rules.

Verify the selected environment from a Python chunk:

```python
import sys
sys.executable
```

## Workspace Viewer

Inline R sessions integrate with vscode-R's workspace watcher when `~/.vscode-R/init.R` is available. In VS Code this is set up by the vscode-R extension. In Open VSX-based editors other than Positron, Rmd Notebooks may show a one-time prompt to install vscode-R if it is missing. Positron users should rely on Positron's built-in R support instead.

You can verify the integration from a notebook cell:

```r
x <- 42
df <- data.frame(a = 1:3, b = letters[1:3])

cat("attached=", "tools:vscode" %in% search(), "\n")
cat("workspace=", file.exists(file.path(tempdir(), "vscode-R", "workspace.json")), "\n")
```

If you do not want inline sessions to source vscode-R's watcher, disable:

```json
{
  "rmdNotebooks.r.sourceVscodeRSessionWatcher": false
}
```

## Current Limits

- Rich Python outputs preserve every MIME alternative emitted by IPython; Matplotlib and Plotnine plots render inline
- Jupyter widgets and other comm-channel-based outputs are not supported; they require a full Jupyter kernel and frontend comm lifecycle
- htmlwidgets and full HTML dependency lifecycles are not supported yet
- Common knitr header options and leading Quarto `#|` options are enforced, including `eval`, `include`, `output`, figure size/aspect/DPI, and output hiding
- `echo`, `warning`, and `message` are parsed but not fully enforced
- Unsupported interactive flows can fall back to an R terminal only when `rmdNotebooks.execution.interactiveFallbackTimeoutMs` is enabled
- vscode-R workspace integration is optional on Open VSX builds and depends on vscode-R's current session watcher internals

## Commands

- `Rmd Notebooks: Run Current Chunk`
- `Rmd Notebooks: Run All Chunks`
- `Rmd Notebooks: Run Inline R`
- `Rmd Notebooks: Stop All Running Chunks`
- `Rmd Notebooks: Clear Current Output`
- `Rmd Notebooks: Clear All Outputs`
- `Rmd Notebooks: Restart Execution Sessions`
- `Rmd Notebooks: Select Python Environment`
- `Rmd Notebooks: Run Current Chunk in R Terminal`
- `Rmd Notebooks: Show Output Panel`
- `Rmd Notebooks: Preview HTML`
- `Rmd Notebooks: Edit Chunk Header`
- `Rmd Notebooks: Toggle Notebook / Raw Source View`

The notebook toolbar exposes `Stop All Running Chunks`, `Restart Execution Sessions`, and `View Source`. Python selection stays available in the status bar and Command Palette without adding a second controller to the notebook kernel picker.

## Settings

- `rmdNotebooks.r.path`: path to the R executable. Defaults to `R`.
- `rmdNotebooks.r.args`: arguments for inline chunk-execution R sessions. Defaults to `["--slave"]`.
- `rmdNotebooks.r.terminalArgs`: arguments for the interactive R terminal. Defaults to `["--vanilla"]`.
- `rmdNotebooks.r.sourceVscodeRSessionWatcher`: source `~/.vscode-R/init.R` in inline R sessions when present. Defaults to `true`; no-ops when vscode-R is not installed.
- `rmdNotebooks.r.startupTimeoutMs`: time allowed for an inline R session to start. Defaults to `30000` milliseconds.
- `rmdNotebooks.python.path`: configured interpreter fallback after a persisted or file/workspace-active Python environment; when empty, selection continues through `QUARTO_PYTHON` and then `python3` on macOS/Linux or `python` on Windows.
- `rmdNotebooks.python.args`: arguments passed before the bundled Python session script. Defaults to `["-u"]`.
- `rmdNotebooks.python.startupTimeoutMs`: time allowed for a Python session to start. Defaults to `30000` milliseconds.
- `rmdNotebooks.execution.interactiveFallbackTimeoutMs`: timeout for treating a stalled inline chunk as unsupported interactive input. Defaults to `0`, which disables the timeout.
- `rmdNotebooks.execution.interactiveFallbackBehavior`: what to do when the optional interactive fallback timeout fires. Defaults to `prompt`.
- `rmdNotebooks.output.dataFrameRender`: render R data frames as HTML tables instead of plain text. Defaults to `true`; Python data frames use IPython's formatter.
- `rmdNotebooks.output.dataFrameMaxRows`: row threshold before R HTML tables collapse to their first and last rows. Defaults to `50`.
- `rmdNotebooks.output.dataFrameMaxColumns`: column threshold before R HTML tables collapse to their first and last columns. Defaults to `50`.

Inline R sessions honor normal startup files by default. To isolate inline sessions from project startup files, add `--vanilla`:

```json
{
  "rmdNotebooks.r.args": ["--slave", "--vanilla"]
}
```

Rendered prose supports both native knitr syntax, such as `` `r value` ``, and Quarto syntax, such as `` `{r} value` ``. Inline prose requires the R package `knitr`; install it with `install.packages("knitr")` if it is not already available. Inline results are textual/Markdown values; plots and rich widgets remain regular chunk outputs.

Python chunks use normal Quarto fences and share state within the document:

````markdown
```{python setup}
values = [1, 2, 3]
```

```{python summary}
sum(values)
```
````

## Development

```bash
npm install
npm run compile
npm test
```

`npm test` is the full local verification path, including the real VS Code extension-host suite. GitHub Actions stays lighter and only runs the unit tests plus packaging checks.

For changes that affect R startup behavior, run the local `renv` smoke test:

```bash
npm run smoke:renv
```

This creates a temporary `renv` project and verifies that the default inline startup args activate the project while `--vanilla` keeps an inline session isolated. The command may install `renv` into a temporary bootstrap library if it is not already available.

For changes that affect vscode-R session watcher integration, run:

```bash
npm run smoke:vscode-r
```

This starts the inline R protocol with the vscode-R watcher enabled and verifies that variables created by a piped inline chunk appear in vscode-R's `workspace.json`.

Release packaging produces two VSIX variants:

```bash
npm run package:vsix:marketplace
npm run package:vsix:openvsx
```

The Marketplace variant keeps the hard vscode-R dependency. The Open VSX variant removes that dependency and uses an optional in-app recommendation for compatible non-Positron hosts.

To create a shareable test build from the current branch, run:

```bash
npm run package:vsix:test
```

This produces a `.vsix` file with the package version, branch name, and commit SHA in the filename.

On macOS, the VS Code extension-host portion of `npm test` may abort if it is launched from a restrictive sandbox. If that happens, rerun `npm run test:vscode` from a normal local shell/session outside the sandbox.

Manual visual sessions:

```bash
npm run dev:visual
npm run dev:visual:rmd
npm run dev:example
npm run dev:example:rmd
```

## CI/CD

- GitHub Actions runs the lightweight repository checks on pushes and pull requests.
- Pull request builds upload a branch-and-SHA-named `.vsix` artifact for manual testing.
- GitHub Actions also handles the release path: it checks that the release tag matches `package.json`, packages the extension as a `.vsix`, attaches it to GitHub releases, and publishes release tags to both the VS Code Marketplace and Open VSX.
- The full macOS extension-host test flow is kept as a local verification step via `npm test`.

## Example Notebooks

- `test/manual-workspace/example.qmd`
- `test/manual-workspace/example.rmd`

## License

MIT
