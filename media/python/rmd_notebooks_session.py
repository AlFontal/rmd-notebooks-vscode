"""Persistent Python execution loop for Rmd Notebooks.

The process communicates over newline-delimited, base64-encoded JSON messages so
user output can never be mistaken for protocol data. It requires IPython so
interactive syntax and rich display behavior match notebook expectations.
"""

from __future__ import annotations

import base64
import builtins
import contextlib
import io
import json
import os
import sys
import time
import traceback
from typing import Any


READY_PREFIX = "RMD_NOTEBOOKS_PYTHON_READY:"
STARTUP_ERROR_PREFIX = "RMD_NOTEBOOKS_PYTHON_STARTUP_ERROR:"
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


class _EventStream(io.TextIOBase):
    def __init__(self, events: list[dict[str, Any]], name: str):
        self.events = events
        self.name = name

    def write(self, value: str) -> int:
        if not value:
            return 0
        if self.events and self.events[-1].get("type") == "stream" and self.events[-1].get("name") == self.name:
            self.events[-1]["text"] += value
        else:
            self.events.append({"type": "stream", "name": self.name, "text": value})
        return len(value)

    def flush(self) -> None:
        return None


def _create_ipython_runtime(
    namespace: dict[str, Any],
) -> tuple[Any, dict[str, Any]] | None:
    try:
        from IPython.core.displayhook import DisplayHook
        from IPython.core.displaypub import DisplayPublisher
        from IPython.core.interactiveshell import InteractiveShell
    except ImportError:
        return None

    state: dict[str, Any] = {"events": []}
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
                state["events"].clear()
                clear_state["pending"] = False

            output = {
                "type": "display_raw",
                "data": data,
                "metadata": metadata or {},
                "transient": transient or {},
                "update": update,
            }
            display_id = (transient or {}).get("display_id")
            output["displayId"] = display_id
            if update and display_id:
                for index in range(len(state["events"]) - 1, -1, -1):
                    if state["events"][index].get("displayId") == display_id:
                        state["events"][index] = output
                        return
            state["events"].append(output)

        def clear_output(self, wait: bool = False) -> None:
            if wait:
                clear_state["pending"] = True
            else:
                state["events"].clear()

    class RmdDisplayHook(DisplayHook):
        def write_output_prompt(self) -> None:
            return None

        def write_format_data(
            self, format_dict: dict[str, Any], md_dict: dict[str, Any] | None = None
        ) -> None:
            if clear_state["pending"]:
                state["events"].clear()
                clear_state["pending"] = False
            state["events"].append({"type": "display_raw", "data": format_dict, "metadata": md_dict or {}})

    class RmdInteractiveShell(InteractiveShell):
        # Base InteractiveShell deliberately leaves GUI-loop integration abstract.
        # The executor is headless, so inline/Agg rendering needs no GUI event loop.
        def enable_gui(self, gui: str | None = None) -> None:
            self.active_eventloop = gui

        def _showtraceback(self, etype: Any, evalue: Any, stb: Any) -> None:
            state["events"].append({"type": "error", "text": self.InteractiveTB.stb2text(stb)})

    shell = RmdInteractiveShell.instance(user_ns=namespace, cache_size=0)
    shell.colors = "NoColor"
    shell.displayhook_class = RmdDisplayHook
    shell.init_displayhook()
    shell.display_pub = RmdDisplayPublisher(parent=shell, shell=shell)
    return shell, state


def _mimebundle_to_items(bundle: dict[str, Any]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for mime_type, value in bundle.items():
        if not isinstance(mime_type, str) or value is None:
            continue
        if isinstance(value, (bytes, bytearray)):
            data = base64.b64encode(bytes(value)).decode("ascii")
            encoding = "base64"
        elif isinstance(value, (dict, list)):
            data = json.dumps(value, ensure_ascii=False)
            encoding = "utf8"
        else:
            data = str(value)
            encoding = "base64" if mime_type.startswith("image/") and mime_type != "image/svg+xml" else "utf8"
        items.append({"mimeType": mime_type, "data": data, "encoding": encoding})
    return items


def _capture_matplotlib_plots(plot: dict[str, Any]) -> list[dict[str, Any]]:
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return []

    displays: list[dict[str, Any]] = []
    width = plot.get("widthInches")
    height = plot.get("heightInches")
    dpi = plot.get("dpi") or 96
    for index, figure_number in enumerate(pyplot.get_fignums(), start=1):
        figure = pyplot.figure(figure_number)
        if width is not None or height is not None:
            current_width, current_height = figure.get_size_inches()
            figure.set_size_inches(width or current_width, height or current_height)
        buffer = io.BytesIO()
        figure.savefig(buffer, format="png", dpi=dpi, bbox_inches="tight")
        displays.append({
            "type": "display",
            "items": [{
                "mimeType": "image/png",
                "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                "encoding": "base64",
            }],
        })
    if displays:
        pyplot.close("all")
    return displays


def _execute(
    request: dict[str, Any],
    ipython_runtime: tuple[Any, dict[str, Any]],
) -> dict[str, Any]:
    started_at = int(time.time() * 1000)
    success = True
    cancelled = False
    events: list[dict[str, Any]] = []

    working_directory = request.get("workingDirectory")
    if working_directory:
        os.chdir(working_directory)
        sys.path[:] = [entry for entry in sys.path if entry != working_directory]
        sys.path.insert(0, working_directory)

    original_input = builtins.input
    builtins.input = _input
    try:
        with contextlib.redirect_stdout(_EventStream(events, "stdout")), contextlib.redirect_stderr(_EventStream(events, "stderr")):
            code = str(request.get("code", ""))
            shell, state = ipython_runtime
            state["events"] = events
            result = shell.run_cell(code, store_history=False, silent=False)
            error = result.error_before_exec or result.error_in_exec
            success = result.success
            cancelled = isinstance(error, KeyboardInterrupt)
    except KeyboardInterrupt:
        cancelled = True
        success = False
    except BaseException:
        success = False
        events.append({"type": "error", "text": traceback.format_exc()})
    finally:
        builtins.input = original_input

    if success:
        try:
            events.extend(_capture_matplotlib_plots(request.get("plot") or {}))
        except Exception:
            success = False
            events.append({"type": "error", "text": traceback.format_exc()})

    normalized_events: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != "display_raw":
            normalized_events.append(event)
            continue
        bundle = event.get("data")
        if isinstance(bundle, dict):
            normalized_events.append({
                "type": "display",
                "items": _mimebundle_to_items(bundle),
                "displayId": event.get("displayId"),
            })

    return {
        "success": success,
        "cancelled": cancelled,
        "startedAt": started_at,
        "finishedAt": int(time.time() * 1000),
        "events": normalized_events,
    }


def main() -> None:
    namespace: dict[str, Any] = {"__name__": "__main__", "__builtins__": builtins}
    ipython_runtime = _create_ipython_runtime(namespace)
    if not ipython_runtime:
        _emit(STARTUP_ERROR_PREFIX, {
            "code": "missing_ipython",
            "message": "Python chunks require IPython in the selected environment."
        })
        return
    _emit(READY_PREFIX, {"engine": "ipython"})

    while True:
        line = sys.__stdin__.readline()
        if not line:
            return
        line = line.rstrip("\r\n")
        if not line.startswith(COMMAND_PREFIX):
            continue
        try:
            request = _decode_message(line[len(COMMAND_PREFIX) :])
            result = _execute(request, ipython_runtime)
        except BaseException:
            now = int(time.time() * 1000)
            result = {
                "success": False,
                "cancelled": False,
                "startedAt": now,
                "finishedAt": now,
                "events": [{"type": "error", "text": traceback.format_exc()}],
            }
        _emit(RESULT_PREFIX, result)


if __name__ == "__main__":
    main()
