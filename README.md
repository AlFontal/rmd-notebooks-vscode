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

Rmd Notebooks turns fenced chunks into runnable notebook cells while keeping the original document unchanged on disk.

## Demo

<img src="./media/readme/demo.gif" alt="Rmd Notebooks for VS Code demo" width="1000" />

## Install

- **VS Code:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AlFontal.rmd-notebooks-vscode)
- **Positron:** [Open VSX](https://open-vsx.org/extension/AlFontal/rmd-notebooks-vscode)
- **Manual:** download a `.vsix` from [GitHub Releases](https://github.com/AlFontal/rmd-notebooks-vscode/releases)

## Features

- Open `.Rmd` and `.qmd` files as native VS Code notebooks without converting the source.
- Run R and Python chunks in persistent per-document sessions with inline text, errors, plots, HTML, Markdown, and data frames.
- Select Python environments through VS Code tooling and integrate R sessions with vscode-R's workspace viewer.
- Persist outputs, preview rendered documents, edit chunk headers, and switch back to raw source at any time.

## Requirements

- VS Code-compatible editor API `^1.110.0`
- R on `PATH`, or configured with `rmdNotebooks.r.path`, for R chunks
- Python on `PATH`, or configured through the extension, plus IPython for Python chunks

The VS Code Marketplace build installs vscode-R integration automatically. The Open VSX build keeps vscode-R optional for compatibility with Positron and other VS Code-compatible editors.

## Documentation

- [Python environments](docs/python-environments.md)
- [R and vscode-R integration](docs/r-integration.md)
- [Commands, settings, and limitations](docs/reference.md)
- [Development and contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

Jupyter widgets and R htmlwidgets that require a full frontend dependency lifecycle are not currently supported. See the [reference](docs/reference.md#known-limitations) for details.

## License

MIT
