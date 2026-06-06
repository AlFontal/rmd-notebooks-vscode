# Changelog

## 0.3.0

- Add `rmdNotebooks.r.startupTimeoutMs` to configure the inline R session startup budget (default 10000ms), for projects with slow R startup (renv, heavy `.Rprofile`, Bioconductor).
- Fix: an inline session that fails to start is no longer cached, so re-running a chunk retries from scratch instead of repeating the startup error.
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
