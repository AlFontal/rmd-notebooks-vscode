"""Persistent Python execution loop for Rmd Notebooks.

The process communicates over newline-delimited, base64-encoded JSON messages so
user output can never be mistaken for protocol data. It uses IPython's execution
and display machinery when the configured environment provides it, and retains a
standard-library fallback otherwise.
"""

from __future__ import annotations

import ast
import base64
import builtins
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import time
import traceback
from typing import Any


READY_PREFIX = "RMD_NOTEBOOKS_PYTHON_READY:"
COMMAND_PREFIX = "RMD_NOTEBOOKS_PYTHON_COMMAND:"
RESULT_PREFIX = "RMD_NOTEBOOKS_PYTHON_RESULT:"
PROMPT_PREFIX = "RMD_NOTEBOOKS_PYTHON_PROMPT:"
PROMPT_RESPONSE_PREFIX = "RMD_NOTEBOOKS_PYTHON_PROMPT_RESPONSE:"


def _encode_message(value: dict[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return base64.b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_message(value: str) -> dict[str, Any]:
    payload = base64.b64decode(value.encode("ascii"), validate=True).decode("utf-8")
    decoded = json.loads(payload)
    if not isinstance(decoded, dict):
        raise ValueError("Protocol message must be a JSON object.")
    return decoded


def _emit(prefix: str, value: dict[str, Any]) -> None:
    sys.__stdout__.write(prefix + _encode_message(value) + "\n")
    sys.__stdout__.flush()


def _read_prompt_response() -> dict[str, Any]:
    line = sys.__stdin__.readline()
    if not line:
        return {"cancelled": True}
    line = line.rstrip("\r\n")
    if not line.startswith(PROMPT_RESPONSE_PREFIX):
        return {"cancelled": True}
    try:
        return _decode_message(line[len(PROMPT_RESPONSE_PREFIX) :])
    except Exception:
        return {"cancelled": True}


def _input(prompt: object = "") -> str:
    prompt_text = str(prompt)
    if prompt_text:
        print(prompt_text, end="")
    _emit(
        PROMPT_PREFIX,
        {
            "kind": "input",
            "title": "Input Required",
            "prompt": prompt_text or "Enter a value",
            "placeHolder": "Type a response",
            "allowEmpty": True,
        },
    )
    response = _read_prompt_response()
    if response.get("cancelled"):
        raise EOFError("Input cancelled")
    return str(response.get("value", ""))


def _create_ipython_runtime(
    namespace: dict[str, Any],
) -> tuple[Any, list[dict[str, Any]], list[str]] | None:
    try:
        from IPython.core.displayhook import DisplayHook
        from IPython.core.displaypub import DisplayPublisher
        from IPython.core.interactiveshell import InteractiveShell
    except ImportError:
        return None

    captured: list[dict[str, Any]] = []
    tracebacks: list[str] = []
    clear_state = {"pending": False}

    class RmdDisplayPublisher(DisplayPublisher):
        def publish(
            self,
            data: dict[str, Any],
            metadata: dict[str, Any] | None = None,
            source: Any = None,
            *,
            transient: dict[str, Any] | None = None,
            update: bool = False,
            **kwargs: Any,
        ) -> None:
            if clear_state["pending"]:
                captured.clear()
                clear_state["pending"] = False

            output = {
                "data": data,
                "metadata": metadata or {},
                "transient": transient or {},
                "update": update,
            }
            display_id = (transient or {}).get("display_id")
            if update and display_id:
                for index in range(len(captured) - 1, -1, -1):
                    if captured[index].get("transient", {}).get("display_id") == display_id:
                        captured[index] = output
                        return
            captured.append(output)

        def clear_output(self, wait: bool = False) -> None:
            if wait:
                clear_state["pending"] = True
            else:
                captured.clear()

    class RmdDisplayHook(DisplayHook):
        def write_output_prompt(self) -> None:
            return None

        def write_format_data(
            self, format_dict: dict[str, Any], md_dict: dict[str, Any] | None = None
        ) -> None:
            if clear_state["pending"]:
                captured.clear()
                clear_state["pending"] = False
            captured.append({"data": format_dict, "metadata": md_dict or {}})

    class RmdInteractiveShell(InteractiveShell):
        # Base InteractiveShell deliberately leaves GUI-loop integration abstract.
        # The executor is headless, so inline/Agg rendering needs no GUI event loop.
        def enable_gui(self, gui: str | None = None) -> None:
            self.active_eventloop = gui

        def _showtraceback(self, etype: Any, evalue: Any, stb: Any) -> None:
            tracebacks.append(self.InteractiveTB.stb2text(stb))

    shell = RmdInteractiveShell.instance(user_ns=namespace, cache_size=0)
    shell.colors = "NoColor"
    shell.displayhook_class = RmdDisplayHook
    shell.init_displayhook()
    shell.display_pub = RmdDisplayPublisher(parent=shell, shell=shell)
    return shell, captured, tracebacks


def _execute_code(code: str, namespace: dict[str, Any]) -> Any:
    """Execute a cell and return its final expression, like a notebook kernel."""
    module = ast.parse(code, filename="<qmd-cell>", mode="exec")
    if not module.body:
        return None

    last_statement = module.body[-1]
    if isinstance(last_statement, ast.Expr):
        prefix = ast.Module(body=module.body[:-1], type_ignores=module.type_ignores)
        if prefix.body:
            exec(compile(prefix, "<qmd-cell>", "exec"), namespace, namespace)
        expression = ast.Expression(last_statement.value)
        return eval(compile(expression, "<qmd-cell>", "eval"), namespace, namespace)

    exec(compile(module, "<qmd-cell>", "exec"), namespace, namespace)
    return None


def _write_mime_image(
    mime_type: str, rendered: Any, artifact_directory: str, stem: str, suffix: str
) -> dict[str, str] | None:
    if not artifact_directory:
        return None
    if isinstance(rendered, str):
        if mime_type == "image/svg+xml":
            data = rendered.encode("utf-8")
        else:
            data = base64.b64decode(rendered)
    elif isinstance(rendered, (bytes, bytearray)):
        data = bytes(rendered)
    else:
        return None

    extensions = {
        "image/png": "png",
        "image/svg+xml": "svg",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
    }
    extension = extensions[mime_type]
    path = Path(artifact_directory) / f"{stem}-{suffix}.{extension}"
    path.write_bytes(data)
    return {"path": str(path), "mimeType": mime_type}


def _mimebundle_to_rich_output(
    bundle: dict[str, Any], artifact_directory: str, stem: str, suffix: str
) -> dict[str, Any] | None:
    if bundle.get("text/html") is not None:
        return {"type": "html", "html": str(bundle["text/html"])}

    for mime_type in ("image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp"):
        if mime_type not in bundle:
            continue
        image = _write_mime_image(mime_type, bundle[mime_type], artifact_directory, stem, suffix)
        return {"type": "image", **image} if image else None

    if bundle.get("text/markdown") is not None:
        return {"type": "markdown", "markdown": str(bundle["text/markdown"])}

    for mime_type in ("application/json", "text/latex", "application/javascript"):
        if mime_type not in bundle:
            continue
        value = bundle[mime_type]
        data = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        return {"type": "mime", "mimeType": mime_type, "data": data}

    for mime_type, value in bundle.items():
        if mime_type == "text/plain" or not isinstance(mime_type, str):
            continue
        if isinstance(value, (bytes, bytearray)):
            return {
                "type": "mime",
                "mimeType": mime_type,
                "data": base64.b64encode(bytes(value)).decode("ascii"),
                "encoding": "base64",
            }
        data = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        return {"type": "mime", "mimeType": mime_type, "data": data, "encoding": "utf8"}

    if bundle.get("text/plain") is not None:
        return {"type": "text", "text": str(bundle["text/plain"])}
    return None


def _render_mimebundle(
    value: Any, artifact_directory: str, stem: str
) -> tuple[str, str, str, list[dict[str, str]]]:
    renderer = getattr(value, "_repr_mimebundle_", None)
    if not callable(renderer):
        return "", "", "", []

    rendered = renderer()
    bundle = rendered[0] if isinstance(rendered, tuple) else rendered
    if not isinstance(bundle, dict):
        return "", "", "", []

    images: list[dict[str, str]] = []
    for mime_type in ("image/png", "image/svg+xml", "image/jpeg"):
        if mime_type not in bundle:
            continue
        image = _write_mime_image(mime_type, bundle[mime_type], artifact_directory, stem, "rich")
        if image:
            images.append(image)
            break

    return (
        str(bundle.get("text/html") or ""),
        str(bundle.get("text/markdown") or ""),
        str(bundle.get("text/plain") or ""),
        images,
    )


def _render_value(
    value: Any,
    request: dict[str, Any],
    stdout: io.StringIO,
    artifact_directory: str,
    stem: str,
) -> tuple[str, str, list[dict[str, str]]]:
    if value is None or str(request.get("code", "")).rstrip().endswith(";"):
        return "", "", []

    data_frame = request.get("dataFrame") or {}
    render_data_frames = data_frame.get("render", True) is not False
    is_pandas_value = type(value).__module__.startswith("pandas.")

    html, markdown, plain, images = _render_mimebundle(value, artifact_directory, stem)
    if render_data_frames or not is_pandas_value:
        html_renderer = getattr(value, "_repr_html_", None)
        if not html and callable(html_renderer):
            if is_pandas_value:
                try:
                    import pandas as pd  # type: ignore[import-not-found]

                    with pd.option_context(
                        "display.max_rows",
                        int(data_frame.get("maxRows", 50)),
                        "display.max_columns",
                        int(data_frame.get("maxColumns", 50)),
                    ):
                        html = html_renderer() or ""
                except Exception:
                    html = html_renderer() or ""
            else:
                html = html_renderer() or ""

    markdown_renderer = getattr(value, "_repr_markdown_", None)
    if not markdown and callable(markdown_renderer):
        markdown = markdown_renderer() or ""

    if not html and not markdown and not images:
        rendered = plain or repr(value)
        if rendered:
            stdout.write(rendered + "\n")

    return str(html), str(markdown), images


def _capture_png_value(value: Any, artifact_directory: str, stem: str) -> list[dict[str, str]]:
    renderer = getattr(value, "_repr_png_", None)
    if not callable(renderer) or not artifact_directory:
        return []
    rendered = renderer()
    if isinstance(rendered, tuple):
        rendered = rendered[0]
    if isinstance(rendered, str):
        rendered = base64.b64decode(rendered)
    if not isinstance(rendered, (bytes, bytearray)):
        return []
    image = _write_mime_image("image/png", rendered, artifact_directory, stem, "value")
    return [image] if image else []


def _capture_matplotlib_plots(
    artifact_directory: str, stem: str, plot: dict[str, Any]
) -> list[dict[str, str]]:
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None or not artifact_directory:
        return []

    images: list[dict[str, str]] = []
    width = plot.get("widthInches")
    height = plot.get("heightInches")
    dpi = plot.get("dpi") or 96
    for index, figure_number in enumerate(pyplot.get_fignums(), start=1):
        figure = pyplot.figure(figure_number)
        if width is not None or height is not None:
            current_width, current_height = figure.get_size_inches()
            figure.set_size_inches(width or current_width, height or current_height)
        path = Path(artifact_directory) / f"{stem}-plot-{index}.png"
        figure.savefig(path, format="png", dpi=dpi, bbox_inches="tight")
        images.append({"path": str(path), "mimeType": "image/png"})
    if images:
        pyplot.close("all")
    return images


def _execute(
    request: dict[str, Any],
    namespace: dict[str, Any],
    ipython_runtime: tuple[Any, list[dict[str, Any]], list[str]] | None,
) -> dict[str, Any]:
    started_at = int(time.time() * 1000)
    stdout = io.StringIO()
    stderr = io.StringIO()
    success = True
    cancelled = False
    html = ""
    markdown = ""
    images: list[dict[str, str]] = []
    rich_outputs: list[dict[str, Any]] = []

    working_directory = request.get("workingDirectory")
    artifact_directory = str(request.get("artifactDirectory") or "")
    if working_directory:
        os.chdir(working_directory)
    if artifact_directory:
        Path(artifact_directory).mkdir(parents=True, exist_ok=True)

    original_input = builtins.input
    builtins.input = _input
    value: Any = None
    stem = f"python-{started_at}-{os.getpid()}"
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = str(request.get("code", ""))
            if ipython_runtime:
                shell, captured, tracebacks = ipython_runtime
                captured.clear()
                tracebacks.clear()
                result = shell.run_cell(code, store_history=False, silent=False)
                error = result.error_before_exec or result.error_in_exec
                success = result.success
                cancelled = isinstance(error, KeyboardInterrupt)
                if tracebacks:
                    stderr.write("\n".join(tracebacks).rstrip() + "\n")
                for index, captured_output in enumerate(captured, start=1):
                    bundle = captured_output.get("data")
                    if not isinstance(bundle, dict):
                        continue
                    output = _mimebundle_to_rich_output(
                        bundle, artifact_directory, stem, f"display-{index}"
                    )
                    if output:
                        rich_outputs.append(output)
            else:
                value = _execute_code(code, namespace)
                html, markdown, rich_images = _render_value(
                    value, request, stdout, artifact_directory, stem
                )
                images.extend(rich_images)
    except KeyboardInterrupt:
        cancelled = True
        success = False
    except BaseException:
        success = False
        traceback.print_exc(file=stderr)
    finally:
        builtins.input = original_input

    if success:
        try:
            if not images:
                images.extend(_capture_png_value(value, artifact_directory, stem))
            images.extend(_capture_matplotlib_plots(artifact_directory, stem, request.get("plot") or {}))
        except Exception:
            success = False
            traceback.print_exc(file=stderr)

    return {
        "success": success,
        "cancelled": cancelled,
        "startedAt": started_at,
        "finishedAt": int(time.time() * 1000),
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "html": html,
        "markdown": markdown,
        "images": images,
        "richOutputs": rich_outputs,
    }


def main() -> None:
    namespace: dict[str, Any] = {"__name__": "__main__", "__builtins__": builtins}
    ipython_runtime = _create_ipython_runtime(namespace)
    _emit(READY_PREFIX, {"engine": "ipython" if ipython_runtime else "python"})

    while True:
        line = sys.__stdin__.readline()
        if not line:
            return
        line = line.rstrip("\r\n")
        if not line.startswith(COMMAND_PREFIX):
            continue
        try:
            request = _decode_message(line[len(COMMAND_PREFIX) :])
            result = _execute(request, namespace, ipython_runtime)
        except BaseException:
            now = int(time.time() * 1000)
            result = {
                "success": False,
                "cancelled": False,
                "startedAt": now,
                "finishedAt": now,
                "stdout": "",
                "stderr": traceback.format_exc(),
                "html": "",
                "markdown": "",
                "images": [],
                "richOutputs": [],
            }
        _emit(RESULT_PREFIX, result)


if __name__ == "__main__":
    main()
