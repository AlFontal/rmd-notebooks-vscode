# Changelog

## Unreleased

- show document frontmatter as an editable, syntax-highlighted YAML cell without making it executable (#19)
- evaluate native knitr and Quarto inline R expressions in rendered, source-preserving prose cells (#20)

## 0.4.1

- publish separate VS Code Marketplace and Open VSX VSIX variants so VS Code keeps the vscode-R dependency while Positron and other Open VSX hosts do not install an incompatible R extension (#17)
- show a one-time vscode-R recommendation in compatible non-Positron hosts when the optional workspace-viewer integration is missing
- mark Rmd Notebooks as the default editor for `.qmd` and `.Rmd` files so VS Code-compatible hosts open them as notebooks by default

## 0.4.0

- queue inline R chunk requests in execution order, show waiting cells as pending, and support cancelling one cell without dropping the rest of the queue
- add `Stop All Running Chunks` to interrupt the active chunk, cancel queued chunks, and stop an in-progress Run All
- render auto-printed data frames, tibbles, and data tables as theme-aware HTML tables, with settings to disable tables or limit displayed rows and columns
- scope execution-order badges to each notebook's R session and reset them when the session restarts (#15)
- add `rmdNotebooks.r.startupTimeoutMs` with a 30-second default and actionable timeout errors for projects with slow R startup
- retry with a fresh inline R session after startup failures instead of retaining the failed session
- restore persisted outputs to the correct cells after reloading a window
- keep outputs cleared with VS Code's notebook toolbar from reappearing when the notebook is reopened

Thanks to @alpelito7 for the (many) contributions in this release!

## 0.3.0

- attach inline R sessions to vscode-R so variables can appear in the R workspace viewer
- run inline chunks in `.GlobalEnv` and honor project `.Rprofile` startup by default
- add vscode-R as an extension dependency
- add a setting to disable vscode-R session watcher sourcing for inline sessions
- fix restart-session resolution when notebook focus is outside the active notebook editor
- add smoke coverage for vscode-R workspace watcher integration

## 0.2.0

- preserve chunk header options such as `eval=FALSE`, `fig.width`, `echo=FALSE`, and `warning=FALSE` when saving after body edits
- keep notebooks clean on open by storing chunk identity in the runtime snapshot instead of writing it back to cell metadata
- disable the inline interactive fallback timeout by default so legitimate slow chunks keep running
- keep the inline R session alive when an opt-in timeout fires, while still allowing terminal fallback
- wire the notebook Stop button to interrupt the active R execution without restarting the session
- catch R interrupts in the inline session shim so interrupted chunks return a normal failed result and the session can continue

## 0.1.7

- start inline R sessions in the document workspace folder so `.Rprofile` can activate project tools such as `renv`
- tighten the local `renv` smoke test so it depends on startup working directory instead of forcing `R_PROFILE_USER`

## 0.1.6

- add configurable R startup arguments for inline chunk sessions and interactive R terminals
- keep existing startup defaults while allowing `renv` projects to remove `--vanilla`
- add a local `renv` startup smoke test via `npm run smoke:renv`

## 0.1.5

- stop `Run All Chunks` after terminal redirection so later cells do not continue in a mismatched inline session
- harden the R session protocol against marker-like output collisions and preserve runtime stderr as chunk output
- switch the VS Code extension-host test launcher to `@vscode/test-electron` and document the macOS sandbox caveat for local verification

## 0.1.4

- support inline prompt UI for common R interactions such as `menu()` and `readline()`
- keep unsupported interactive flows on the existing terminal fallback path

## 0.1.3

- publish GitHub release tags to the VS Code Marketplace via GitHub Actions

## 0.1.2

- remove unreliable Marketplace stats badges from the README
- verify the GitHub release workflow after fixing release asset upload permissions

## 0.1.1

- refresh release assets and packaging metadata
- restore GitHub release packaging flow with attached `.vsix` artifacts

## 0.1.0

- first preview release
- notebook-backed `.Rmd` and `.qmd` opening
- R chunk execution with inline stdout, stderr, HTML, and static plots
- output persistence and stale tracking
- chunk-header editing
- notebook/raw-source toggle
