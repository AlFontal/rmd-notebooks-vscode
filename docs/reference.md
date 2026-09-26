# Reference

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

The notebook toolbar also exposes preview, stop, restart, and source-view actions where relevant.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `rmdNotebooks.r.path` | `R` | R executable |
| `rmdNotebooks.r.args` | `["--slave"]` | Arguments for inline R sessions |
| `rmdNotebooks.r.terminalArgs` | `["--vanilla"]` | Arguments for the interactive R terminal |
| `rmdNotebooks.r.sourceVscodeRSessionWatcher` | `true` | Source vscode-R's session watcher when available |
| `rmdNotebooks.r.startupTimeoutMs` | `30000` | R startup timeout |
| `rmdNotebooks.python.path` | empty | Configured Python fallback |
| `rmdNotebooks.python.args` | `["-u"]` | Arguments before the bundled Python session script |
| `rmdNotebooks.python.startupTimeoutMs` | `30000` | Python startup timeout |
| `rmdNotebooks.execution.interactiveFallbackTimeoutMs` | `0` | Timeout before treating an inline chunk as requiring terminal input; `0` disables it |
| `rmdNotebooks.execution.interactiveFallbackBehavior` | `prompt` | Fallback behavior: `prompt`, `terminal`, or `error` |
| `rmdNotebooks.output.dataFrameRender` | `true` | Render R data frames as HTML tables |
| `rmdNotebooks.output.dataFrameMaxRows` | `50` | Row threshold for collapsed R data frames |
| `rmdNotebooks.output.dataFrameMaxColumns` | `50` | Column threshold for collapsed R data frames |

`rmdNotebooks.output.maxTextLines`, `output.maxPreviewCharacters`, `output.plotWidth`, `output.plotHeight`, and `output.revealMode` are deprecated. They belonged to the removed raw-editor execution mode, have no effect, and will be removed in a future release.

## Chunk options

Common knitr chunk-header options and leading Quarto `#|` options are supported, including `eval`, `include`, `output`, figure size/aspect/DPI, and output hiding.

`echo`, `warning`, and `message` are parsed but are not fully enforced.

## Known limitations

- Jupyter widgets and other comm-channel-based outputs are not supported because they require a full Jupyter kernel/frontend comm lifecycle.
- R htmlwidgets and full HTML dependency lifecycles are not supported yet.
- Matplotlib figures that fall back to static PNG output are appended after the cell finishes, so their ordering relative to later stream output is not guaranteed.
- Some knitr and Quarto chunk options are only partially enforced.
- Unsupported interactive R flows require terminal execution unless the optional fallback timeout is enabled.
- vscode-R workspace integration depends on vscode-R's current session-watcher internals.

## Output behavior

Outputs are persisted with the notebook and restored when the document is reopened. Editing code marks stored output as stale.

Python preserves IPython MIME bundles and ordered stream/rich-display events. R data frames can render as HTML tables according to the settings above.
