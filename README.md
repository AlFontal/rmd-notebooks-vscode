<p align="center">
  <img src="./media/readme/logo.png" alt="Rmd Notebooks for VS Code logo" width="96" />
</p>

# Rmd Notebooks for VS Code

<p align="center">
  <img alt="Preview" src="https://img.shields.io/badge/status-preview-E67E22" />
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/AlFontal/rmd-notebooks-vscode/ci.yml?branch=main&label=ci" />
  <a href="https://marketplace.visualstudio.com/items?itemName=AlFontal.rmd-notebooks-vscode"><img alt="Install for VS Code" src="https://img.shields.io/badge/install-for%20VS%20Code-007ACC?logo=visualstudiocode&logoColor=white" /></a>
  <a href="https://open-vsx.org/extension/AlFontal/rmd-notebooks-vscode"><img alt="Install for Positron" src="https://img.shields.io/badge/install-for%20Positron-447099" /></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.88-007ACC?logo=visualstudiocode&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2E8B57" />
</p>

Open `.Rmd` and `.qmd` files as runnable R notebooks in VS Code while keeping the source file on disk in fenced-source form.

For many R users, the default workflow has long been R Markdown in RStudio: write code in chunks, run them inline, and inspect plots and tables right where they were produced. Quarto (`.qmd`) keeps that same chunk-oriented workflow while broadening the document model.

In VS Code, that experience has usually been weaker. You can edit `.Rmd` and `.qmd` as text, and you can send code to an R terminal, but you do not normally get a proper inline notebook workflow with rendered outputs living next to the code.

This extension closes most of that gap. It opens `.Rmd` and `.qmd` files as runnable R notebooks in VS Code, keeps the underlying source on disk in fenced-source form, and lets you switch back to the raw file whenever you want.

## Demo

<img src="./media/readme/demo.gif" alt="Rmd Notebooks for VS Code demo" width="1000" />

## Install

- VS Code: install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AlFontal.rmd-notebooks-vscode)
- Positron: install from [Open VSX](https://open-vsx.org/extension/AlFontal/rmd-notebooks-vscode)
- Manual: download the `.vsix` from the [GitHub releases page](https://github.com/AlFontal/rmd-notebooks-vscode/releases)

## Status

This project is working and publishable as a preview extension.

Current capabilities:

- opens `.Rmd` and `.qmd` as notebooks
- runs R code cells in a persistent per-document R session
- renders inline stdout, stderr, HTML, and static plots
- restores cached outputs on reopen
- marks outputs stale after code edits
- supports chunk-header editing from notebook mode
- supports inline prompt UI for common R interactions such as `menu()` and `readline()`
- lets you switch between notebook view and raw source view

Current limits:

- R only
- static image plots only
- no htmlwidgets
- only a small subset of knitr options is enforced today: `eval=FALSE`, `include=FALSE`, `results='hide'`
- unsupported interactive flows still fall back to an R terminal after timeout

## Commands

- `Rmd Notebooks: Run Current Chunk`
- `Rmd Notebooks: Run All Chunks`
- `Rmd Notebooks: Clear Current Output`
- `Rmd Notebooks: Clear All Outputs`
- `Rmd Notebooks: Restart R Session`
- `Rmd Notebooks: Run Current Chunk in R Terminal`
- `Rmd Notebooks: Show Output Panel`
- `Rmd Notebooks: Edit Chunk Header`
- `Rmd Notebooks: Toggle Notebook / Raw Source View`

The notebook toolbar also exposes `Restart R Session` and `View Source`.

Common prompt-style interactions such as `menu()` and `readline()` are handled inline with VS Code pickers and input boxes. If execution still appears to stall because a chunk wants unsupported interactive input, the extension can prompt to run that chunk in an integrated R terminal instead. This is controlled by `rmdNotebooks.execution.interactiveFallbackBehavior` and `rmdNotebooks.execution.interactiveFallbackTimeoutMs`.

## Development

```bash
npm install
npm run compile
npm test
```

`npm test` is the full local verification path, including the real VS Code extension-host suite. GitHub Actions stays lighter and only runs the unit tests plus packaging checks.

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
- GitHub Actions also handles the release path: it packages the extension as a `.vsix`, attaches it to GitHub releases, and publishes release tags to both the VS Code Marketplace and Open VSX.
- The full macOS extension-host test flow is kept as a local verification step via `npm test`.

## Example notebooks

- `test/manual-workspace/example.qmd`
- `test/manual-workspace/example.rmd`

## License

MIT
