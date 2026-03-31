# Changelog

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
