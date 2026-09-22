# R and vscode-R integration

R chunks run in persistent per-document R sessions.

## Working directory and startup

Chunks run from the source document's directory, matching the document-relative behavior expected from R Markdown and Quarto.

R startup files are honored by default, including project `.Rprofile` files and `renv` activation. Inline sessions use:

```json
{
  "rmdNotebooks.r.args": ["--slave"]
}
```

To isolate notebook sessions from startup files, add `--vanilla`:

```json
{
  "rmdNotebooks.r.args": ["--slave", "--vanilla"]
}
```

## vscode-R workspace viewer

When `~/.vscode-R/init.R` is available, Rmd Notebooks can source vscode-R's session watcher so objects created in notebook cells appear in vscode-R's workspace viewer.

The VS Code Marketplace package installs vscode-R as a dependency. The Open VSX package keeps it optional so Positron can use its built-in R support.

To disable the watcher:

```json
{
  "rmdNotebooks.r.sourceVscodeRSessionWatcher": false
}
```

The integration depends on vscode-R's current session-watcher mechanism and may change if vscode-R changes those internals.

## Inline R in prose

Rendered prose supports both native knitr syntax such as ``r value`` and Quarto syntax such as ``{r} value``.

Inline prose evaluation requires the R package `knitr`:

```r
install.packages("knitr")
```

Inline expressions produce textual or Markdown values. Plots and rich widgets should remain regular chunks.

## Interactive input

Common interactions such as `menu()` and `readline()` are surfaced through VS Code UI.

For workflows that require a real terminal, use **Rmd Notebooks: Run Current Chunk in R Terminal**. The optional interactive fallback timeout can also prompt for terminal execution when an inline chunk appears to be waiting for unsupported input.
