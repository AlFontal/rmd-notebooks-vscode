# Python environments

Rmd Notebooks runs Python chunks with a persistent per-document IPython session.

## Selecting an environment

You can select Python through any of these entry points:

- the notebook kernel picker, using an `Rmd: <environment>` entry
- **Rmd Notebooks: Select Python Environment** from the Command Palette
- the `Python: <environment>` status-bar control shown for notebooks containing Python cells

Explicit choices are remembered per document. Choose **Automatic - Follow Workspace Python** or switch back to the default **Rmd Notebooks** controller to remove the override.

## Automatic selection

The default controller follows the active file/workspace Python environment when available, then falls back to:

1. `rmdNotebooks.python.path`
2. `QUARTO_PYTHON`
3. `python3` on macOS/Linux or `python` on Windows

Environment discovery uses the VS Code Python Environments API where available. Changing environments disposes the existing Python session and starts a fresh one on the next execution.

## Execution behavior

Python chunks run from the source document's directory, so sibling imports and relative paths behave like Quarto.

IPython is required for Python execution. If it is missing, Rmd Notebooks can offer to install it in the selected environment. IPython provides magics, shell escapes, top-level `await`, `display()`, rich representations, and formatter support used by libraries such as Pandas, Matplotlib, and Plotnine.

To verify the active interpreter:

```python
import sys
sys.executable
```

If a Python process crashes, the next execution starts a fresh session.

## Quarto interaction

Rmd Notebooks does not rewrite `jupyter:` frontmatter or treat Jupyter kernelspecs as its own execution environments.

For Python-only `.qmd` files without an explicit `jupyter:` pin, extension-triggered Quarto previews receive the selected interpreter through a scoped `QUARTO_PYTHON` override.

Mixed R/Python documents and documents with an explicit `jupyter:` configuration remain under Quarto's own runtime rules.
