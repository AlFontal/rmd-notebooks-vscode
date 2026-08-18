local({
protocol_env <- new.env(parent = emptyenv())
user_env <- globalenv()

options(menu.graphics = FALSE)

rmd_notebooks_encode_line <- function(value) {
  utils::URLencode(enc2utf8(value), reserved = TRUE)
}

rmd_notebooks_decode_line <- function(value) {
  utils::URLdecode(value)
}

rmd_notebooks_emit_section <- function(name, lines) {
  cat(sprintf("SECTION:%s:COUNT:%d\n", name, length(lines)))
  if (length(lines) > 0) {
    for (line in lines) {
      cat("LINE:", rmd_notebooks_encode_line(line), "\n", sep = "")
    }
  }
}

rmd_notebooks_render_html <- function(value) {
  if (inherits(value, "rmd_notebooks_html") || inherits(value, "inline_chunks_html")) {
    return(value$html)
  }

  if (requireNamespace("htmltools", quietly = TRUE) &&
      (inherits(value, "html") || inherits(value, "shiny.tag") || inherits(value, "shiny.tag.list"))) {
    rendered <- htmltools::renderTags(value)
    return(rendered$html)
  }

  NULL
}

rmd_notebooks_render_markdown <- function(value) {
  if (inherits(value, "rmd_notebooks_markdown")) {
    return(value$markdown)
  }

  NULL
}

rmd_notebooks_escape_html <- function(text) {
  text <- as.character(text)
  text <- gsub("&", "&amp;", text, fixed = TRUE)
  text <- gsub("<", "&lt;", text, fixed = TRUE)
  text <- gsub(">", "&gt;", text, fixed = TRUE)
  text
}

rmd_notebooks_truncation_plan <- function(total, max_items, shown_cap) {
  truncated <- is.finite(max_items) && max_items > 0 && total > max_items
  shown <- if (truncated) min(shown_cap, as.integer(max_items)) else total
  head_count <- as.integer(ceiling(shown / 2))
  tail_count <- shown - head_count
  indices <- c(
    if (head_count > 0) seq_len(head_count) else integer(),
    if (tail_count > 0) seq.int(total - tail_count + 1L, total) else integer()
  )
  list(truncated = truncated, indices = indices, head_count = head_count, tail_count = tail_count)
}

rmd_notebooks_format_data_frame <- function(df, row_indices, column_indices) {
  selected_rows <- as.data.frame(df[row_indices, , drop = FALSE])
  selected <- selected_rows[, column_indices, drop = FALSE]
  if (ncol(selected) == 0) {
    return(matrix(character(), nrow = nrow(selected), ncol = 0))
  }
  as.matrix(format(selected, trim = TRUE, justify = "left"))
}

rmd_notebooks_truncate_formatted_columns <- function(display, max_columns, force = FALSE) {
  plan <- rmd_notebooks_truncation_plan(ncol(display), max_columns, 20L)
  if (!force && !plan$truncated) {
    return(display)
  }

  if (!plan$truncated) {
    shown <- min(20L, as.integer(max_columns), ncol(display))
    plan$head_count <- as.integer(ceiling(shown / 2))
    plan$tail_count <- shown - plan$head_count
    plan$indices <- c(
      if (plan$head_count > 0) seq_len(plan$head_count) else integer(),
      if (plan$tail_count > 0) seq.int(ncol(display) - plan$tail_count + 1L, ncol(display)) else integer()
    )
  }

  head_columns <- if (plan$head_count > 0) display[, utils::head(plan$indices, plan$head_count), drop = FALSE] else NULL
  tail_columns <- if (plan$tail_count > 0) display[, utils::tail(plan$indices, plan$tail_count), drop = FALSE] else NULL
  ellipsis <- matrix(rep("...", nrow(display)), ncol = 1, dimnames = list(NULL, "..."))
  do.call(cbind, Filter(Negate(is.null), list(head_columns, ellipsis, tail_columns)))
}

rmd_notebooks_format_rows <- function(display, row_labels) {
  escaped <- if (ncol(display) == 0) {
    matrix(character(), nrow = nrow(display), ncol = 0)
  } else {
    result <- apply(display, 2, rmd_notebooks_escape_html)
    if (is.null(dim(result))) {
      result <- matrix(result, nrow = nrow(display), dimnames = dimnames(display))
    }
    result
  }
  row_labels <- rmd_notebooks_escape_html(row_labels)

  vapply(seq_len(nrow(display)), function(row_index) {
    cells <- escaped[row_index, , drop = TRUE]
    sprintf(
      "<tr><th>%s</th>%s</tr>",
      if (length(row_labels) >= row_index) row_labels[row_index] else "",
      paste0("<td>", cells, "</td>", collapse = "")
    )
  }, character(1))
}

rmd_notebooks_data_frame_to_html <- function(df, max_rows, max_columns) {
  total_rows <- nrow(df)
  total_cols <- ncol(df)
  row_plan <- rmd_notebooks_truncation_plan(total_rows, max_rows, 10L)
  column_plan <- rmd_notebooks_truncation_plan(total_cols, max_columns, 20L)
  display <- rmd_notebooks_format_data_frame(df, row_plan$indices, column_plan$indices)
  display <- rmd_notebooks_truncate_formatted_columns(display, max_columns, column_plan$truncated)

  row_labels <- rownames(df)[row_plan$indices]
  formatted_rows <- rmd_notebooks_format_rows(display, row_labels)
  body_rows <- formatted_rows
  if (row_plan$truncated) {
    ellipsis <- sprintf(
      "<tr class=\"rmd-df-ellipsis\"><th>...</th>%s</tr>",
      paste(rep("<td>...</td>", ncol(display)), collapse = "")
    )
    body_rows <- append(formatted_rows, ellipsis, after = row_plan$head_count)
  }

  header_cells <- if (ncol(display) > 0) {
    paste0("<th>", rmd_notebooks_escape_html(colnames(display)), "</th>", collapse = "")
  } else {
    ""
  }
  thead <- sprintf("<thead><tr><th></th>%s</tr></thead>", header_cells)
  tbody <- sprintf("<tbody>%s</tbody>", paste(body_rows, collapse = ""))

  # pandas only prints the dimensions line when the frame is truncated.
  meta <- if (row_plan$truncated || column_plan$truncated || ncol(display) > max_columns) {
    sprintf("<p class=\"rmd-df-meta\">%d rows &times; %d columns</p>", total_rows, total_cols)
  } else {
    ""
  }

  style <- paste(
    ".rmd-df{color:var(--vscode-editor-foreground,var(--vscode-foreground));font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);padding:4px 0;max-width:100%;overflow-x:auto;}",
    ".rmd-df table.dataframe{border-collapse:collapse;border:none;}",
    ".rmd-df table.dataframe th,.rmd-df table.dataframe td{padding:0.3em 0.8em;text-align:right;white-space:nowrap;border:none;vertical-align:middle;}",
    ".rmd-df table.dataframe thead th{font-weight:bold;background:var(--vscode-keybindingTable-headerBackground,var(--vscode-editorWidget-background));border-bottom:1px solid var(--vscode-editorWidget-border,var(--vscode-panel-border));}",
    ".rmd-df table.dataframe tbody th{font-weight:bold;color:var(--vscode-descriptionForeground);}",
    ".rmd-df table.dataframe tbody tr:nth-child(even){background:var(--vscode-list-hoverBackground);}",
    ".rmd-df table.dataframe tbody tr:hover{background:var(--vscode-list-inactiveSelectionBackground);}",
    ".rmd-df .rmd-df-meta{color:var(--vscode-descriptionForeground);font-size:0.9em;margin:6px 0 0;}",
    sep = ""
  )

  sprintf(
    "<div class=\"rmd-df\"><style>%s</style><table class=\"dataframe\">%s%s</table>%s</div>",
    style,
    thead,
    tbody,
    meta
  )
}

rmd_notebooks_collect_plot_paths <- function(directory, started_at) {
  pattern <- sprintf("^plot-%s-.*\\.png$", started_at)
  if (!dir.exists(directory)) {
    return(character())
  }

  paths <- list.files(directory, pattern = pattern, full.names = TRUE)
  keep <- character()
  for (candidate in paths) {
    info <- file.info(candidate)
    if (!is.na(info$size) && info$size > 2500) {
      keep <- c(keep, candidate)
    } else if (file.exists(candidate)) {
      unlink(candidate)
    }
  }
  keep
}

rmd_notebooks_read_prompt_response <- function() {
  start <- readLines(con = stdin(), n = 1, warn = FALSE)
  if (length(start) == 0 || !identical(start, "RMD_NOTEBOOKS_PROMPT_RESPONSE_START")) {
    return(list(cancelled = TRUE, value = ""))
  }

  status <- readLines(con = stdin(), n = 1, warn = FALSE)
  value <- readLines(con = stdin(), n = 1, warn = FALSE)
  end <- readLines(con = stdin(), n = 1, warn = FALSE)

  if (length(end) == 0 || !identical(end, "RMD_NOTEBOOKS_PROMPT_RESPONSE_END")) {
    return(list(cancelled = TRUE, value = ""))
  }

  list(
    cancelled = identical(sub("^STATUS:", "", status), "cancelled"),
    value = sub("^VALUE:", "", value)
  )
}

rmd_notebooks_emit_protocol_lines <- function(lines) {
  output_connection <- get0("active_stdout_connection", envir = protocol_env, inherits = FALSE)
  message_connection <- get0("active_stderr_connection", envir = protocol_env, inherits = FALSE)
  output_was_sunk <- sink.number() > 0
  message_was_sunk <- sink.number(type = "message") > 2

  if (message_was_sunk) {
    sink(type = "message")
  }
  if (output_was_sunk) {
    sink()
  }

  on.exit({
    if (output_was_sunk && !is.null(output_connection)) {
      sink(output_connection)
    }
    if (message_was_sunk && !is.null(message_connection)) {
      sink(message_connection, type = "message")
    }
  }, add = TRUE)

  for (line in lines) {
    cat(line, "\n", sep = "")
  }
  flush.console()
}

rmd_notebooks_request_prompt <- function(kind, prompt, choice_labels = character(), choice_values = character(), title = NULL, default = "", allow_empty = TRUE, placeholder = NULL) {
  protocol_lines <- c(
    "RMD_NOTEBOOKS_PROMPT_START",
    sprintf("KIND:%s", kind),
    sprintf("ALLOW_EMPTY:%s", if (isTRUE(allow_empty)) "1" else "0"),
    sprintf("DEFAULT:%s", paste(default, collapse = " ")),
    sprintf("PLACEHOLDER:%s", paste(if (is.null(placeholder)) "" else placeholder, collapse = " ")),
    sprintf("SECTION:TITLE:COUNT:%d", if (!is.null(title) && nzchar(title)) 1 else 0),
    if (!is.null(title) && nzchar(title)) sprintf("LINE:%s", rmd_notebooks_encode_line(title)) else character(),
    sprintf("SECTION:PROMPT:COUNT:%d", length(prompt)),
    vapply(prompt, function(line) sprintf("LINE:%s", rmd_notebooks_encode_line(line)), character(1), USE.NAMES = FALSE),
    sprintf("SECTION:CHOICE_LABELS:COUNT:%d", length(choice_labels)),
    vapply(choice_labels, function(line) sprintf("LINE:%s", rmd_notebooks_encode_line(line)), character(1), USE.NAMES = FALSE),
    sprintf("SECTION:CHOICE_VALUES:COUNT:%d", length(choice_values)),
    vapply(choice_values, function(line) sprintf("LINE:%s", rmd_notebooks_encode_line(line)), character(1), USE.NAMES = FALSE),
    "RMD_NOTEBOOKS_PROMPT_END"
  )
  rmd_notebooks_emit_protocol_lines(protocol_lines)
  rmd_notebooks_read_prompt_response()
}

rmd_notebooks_readline <- function(prompt = "") {
  prompt_text <- paste(prompt, collapse = "\n")
  if (nzchar(prompt_text)) {
    cat(prompt_text, "\n", sep = "")
  }

  response <- rmd_notebooks_request_prompt(
    kind = "input",
    prompt = if (nzchar(prompt_text)) prompt_text else "Enter a value",
    title = "Input Required",
    allow_empty = TRUE,
    placeholder = "Type a response"
  )

  if (isTRUE(response$cancelled)) {
    return("")
  }

  response$value
}

rmd_notebooks_menu <- function(choices, graphics = FALSE, title = NULL) {
  labels <- as.character(choices)
  values <- as.character(seq_along(labels))
  prompt_lines <- c(
    if (!is.null(title) && nzchar(title)) title else "Make a selection",
    paste(sprintf("%d: %s", seq_along(labels), labels), collapse = "\n")
  )
  cat(paste(prompt_lines, collapse = "\n"), "\n", sep = "")

  response <- rmd_notebooks_request_prompt(
    kind = "select",
    prompt = if (!is.null(title) && nzchar(title)) title else "Select an option",
    choice_labels = labels,
    choice_values = values,
    title = "Selection",
    allow_empty = TRUE,
    placeholder = "Press Enter to confirm or Escape to cancel"
  )

  if (isTRUE(response$cancelled) || !nzchar(response$value)) {
    return(0L)
  }

  suppressWarnings(as.integer(response$value))
}

rmd_notebooks_ask_yes_no <- function(msg, default = NA, ...) {
  prompt_text <- paste(msg, collapse = "\n")
  cat(prompt_text, "\n", sep = "")

  response <- rmd_notebooks_request_prompt(
    kind = "confirm",
    prompt = prompt_text,
    choice_labels = c("Yes", "No"),
    choice_values = c("yes", "no"),
    title = "Confirmation",
    allow_empty = is.na(default),
    placeholder = "Choose Yes or No"
  )

  if (isTRUE(response$cancelled) || !nzchar(response$value)) {
    return(default)
  }

  identical(response$value, "yes")
}

rmd_notebooks_patch_binding <- function(environment, name, value) {
  if (!exists(name, envir = environment, inherits = FALSE)) {
    return(invisible(FALSE))
  }

  was_locked <- bindingIsLocked(name, environment)
  if (was_locked) {
    unlockBinding(name, environment)
  }
  assign(name, value, envir = environment)
  if (was_locked) {
    lockBinding(name, environment)
  }

  invisible(TRUE)
}

rmd_notebooks_patch_attached_package_binding <- function(package, name, value) {
  environment_name <- paste0("package:", package)
  if (!environment_name %in% search()) {
    return(invisible(FALSE))
  }

  rmd_notebooks_patch_binding(as.environment(environment_name), name, value)
}

rmd_notebooks_source_vscode_r_session_watcher <- function() {
  if (!identical(Sys.getenv("RMD_NOTEBOOKS_SOURCE_VSCODE_R_INIT"), "1")) {
    return(invisible(FALSE))
  }

  init_path <- file.path(path.expand("~"), ".vscode-R", "init.R")
  if (!file.exists(init_path)) {
    return(invisible(FALSE))
  }

  tryCatch({
    init_text <- readLines(init_path, warn = FALSE)
    init_line <- init_text[grepl("R/session/init[.]R", init_text)][1]
    if (is.na(init_line)) {
      return(invisible(FALSE))
    }

    vsc_path <- sub('^local\\(source\\("([^"]+)".*$', "\\1", init_line)
    if (!nzchar(vsc_path) || !file.exists(vsc_path)) {
      return(invisible(FALSE))
    }

    if ("tools:vscode" %in% search()) {
      detach("tools:vscode", character.only = TRUE)
    }

    vsc_parent <- new.env(parent = user_env)
    vsc_env <- new.env(parent = vsc_parent)
    assign(".vsc", vsc_env, envir = vsc_parent)
    assign("dir_init", dirname(vsc_path), envir = vsc_env)
    source(file.path(dirname(vsc_path), "vsc.R"), local = vsc_env)

    exports <- local({
      .vsc <- vsc_env
      .vsc.attach <- .vsc$attach
      .vsc.view <- .vsc$show_dataview
      .vsc.browser <- .vsc$show_browser
      .vsc.viewer <- .vsc$show_viewer
      .vsc.page_viewer <- .vsc$show_page_viewer
      View <- .vsc.view
      environment()
    })
    attach(exports, name = "tools:vscode", warn.conflicts = FALSE)
    exports$.vsc.attach()
    assign("vscode_r_session_watcher_env", vsc_env, envir = protocol_env)
    invisible(TRUE)
  }, error = function(error_condition) {
    message(sprintf("Unable to source vscode-R session watcher init.R: %s", conditionMessage(error_condition)))
    invisible(FALSE)
  })
}

rmd_notebooks_update_vscode_r_workspace <- function() {
  vsc_env <- get0("vscode_r_session_watcher_env", envir = protocol_env, inherits = FALSE)
  if (is.null(vsc_env) || !exists("update_workspace", envir = vsc_env, inherits = FALSE)) {
    return(invisible(FALSE))
  }

  tryCatch({
    vsc_env$update_workspace()
    invisible(TRUE)
  }, error = function(error_condition) {
    message(sprintf("Unable to update vscode-R workspace: %s", conditionMessage(error_condition)))
    invisible(FALSE)
  })
}

rmd_notebooks_execute <- function(code, working_directory, artifact_directory, plot_width_in, plot_height_in, plot_dpi, df_render, df_max_rows, df_max_columns) {
  if (nzchar(working_directory) && dir.exists(working_directory)) {
    setwd(working_directory)
  }

  if (nzchar(artifact_directory) && !dir.exists(artifact_directory)) {
    dir.create(artifact_directory, recursive = TRUE, showWarnings = FALSE)
  }

  started_at <- as.numeric(Sys.time()) * 1000
  stdout_buffer <- character()
  stderr_buffer <- character()
  html_buffer <- character()
  markdown_buffer <- character()
  stdout_connection <- textConnection("stdout_buffer", "w", local = TRUE)
  stderr_connection <- textConnection("stderr_buffer", "w", local = TRUE)
  assign("active_stdout_connection", stdout_connection, envir = protocol_env)
  assign("active_stderr_connection", stderr_connection, envir = protocol_env)
  width_in <- if (is.finite(plot_width_in) && plot_width_in > 0) plot_width_in else 10
  height_in <- if (is.finite(plot_height_in) && plot_height_in > 0) plot_height_in else 7.5
  dpi <- if (is.finite(plot_dpi) && plot_dpi > 0) plot_dpi else 96
  plot_width_px <- max(1, as.integer(round(width_in * dpi)))
  plot_height_px <- max(1, as.integer(round(height_in * dpi)))

  plot_pattern <- if (nzchar(artifact_directory)) {
    file.path(artifact_directory, sprintf("plot-%s-%%03d.png", started_at))
  } else {
    tempfile(pattern = sprintf("rmd-notebooks-%s-", started_at), fileext = ".png")
  }

  sink(stdout_connection)
  sink(stderr_connection, type = "message")
  grDevices::png(filename = plot_pattern, width = plot_width_px, height = plot_height_px, res = dpi)

  success <- TRUE
  tryCatch({
    withCallingHandlers({
      expressions <- parse(text = code, keep.source = FALSE)
      for (expression in expressions) {
        result <- withVisible(eval(expression, envir = user_env))
        if (result$visible && !is.null(result$value)) {
          markdown_output <- rmd_notebooks_render_markdown(result$value)
          if (!is.null(markdown_output)) {
            markdown_buffer <- c(markdown_buffer, markdown_output)
          } else {
            html_output <- rmd_notebooks_render_html(result$value)
            if (is.null(html_output) && isTRUE(df_render) && is.data.frame(result$value)) {
              html_output <- rmd_notebooks_data_frame_to_html(result$value, df_max_rows, df_max_columns)
            }
            if (!is.null(html_output)) {
              html_buffer <- c(html_buffer, html_output)
            } else {
              print(result$value)
            }
          }
        }
      }
    }, warning = function(warning_condition) {
      message(conditionMessage(warning_condition))
      invokeRestart("muffleWarning")
    }, message = function(message_condition) {
      message(conditionMessage(message_condition))
      invokeRestart("muffleMessage")
    })
  }, error = function(error_condition) {
    success <<- FALSE
    message(conditionMessage(error_condition))
  }, interrupt = function(interrupt_condition) {
    success <<- FALSE
    message("Execution interrupted.")
  })

  rmd_notebooks_update_vscode_r_workspace()

  grDevices::dev.off()
  sink(type = "message")
  sink()
  close(stdout_connection)
  close(stderr_connection)
  rm(list = c("active_stdout_connection", "active_stderr_connection"), envir = protocol_env)

  list(
    success = success,
    started_at = started_at,
    finished_at = as.numeric(Sys.time()) * 1000,
    stdout = stdout_buffer,
    stderr = stderr_buffer,
    html = html_buffer,
    markdown = markdown_buffer,
    plots = rmd_notebooks_collect_plot_paths(artifact_directory, started_at)
  )
}

assign("rmd_notebooks_html", function(html) {
  structure(list(html = paste(html, collapse = "\n")), class = "rmd_notebooks_html")
}, envir = user_env)

assign("inline_chunks_html", get("rmd_notebooks_html", envir = user_env), envir = user_env)

rmd_notebooks_patch_binding(baseenv(), "readline", rmd_notebooks_readline)
rmd_notebooks_patch_binding(asNamespace("utils"), "menu", rmd_notebooks_menu)
rmd_notebooks_patch_binding(asNamespace("utils"), "askYesNo", rmd_notebooks_ask_yes_no)
rmd_notebooks_patch_attached_package_binding("utils", "menu", rmd_notebooks_menu)
rmd_notebooks_patch_attached_package_binding("utils", "askYesNo", rmd_notebooks_ask_yes_no)
rmd_notebooks_source_vscode_r_session_watcher()

cat("RMD_NOTEBOOKS_READY\n")
flush.console()

repeat {
  command <- readLines(con = stdin(), n = 1, warn = FALSE)
  if (length(command) == 0) {
    break
  }

  if (!identical(command, "RMD_NOTEBOOKS_COMMAND_V2")) {
    next
  }

  working_directory <- readLines(con = stdin(), n = 1, warn = FALSE)
  artifact_directory <- readLines(con = stdin(), n = 1, warn = FALSE)
  plot_width_in <- readLines(con = stdin(), n = 1, warn = FALSE)
  plot_height_in <- readLines(con = stdin(), n = 1, warn = FALSE)
  plot_dpi <- readLines(con = stdin(), n = 1, warn = FALSE)
  df_render_line <- readLines(con = stdin(), n = 1, warn = FALSE)
  df_max_rows_line <- readLines(con = stdin(), n = 1, warn = FALSE)
  df_max_columns_line <- readLines(con = stdin(), n = 1, warn = FALSE)
  code_count_line <- readLines(con = stdin(), n = 1, warn = FALSE)

  working_directory <- sub("^WORKDIR:", "", working_directory)
  artifact_directory <- sub("^ARTIFACT_DIR:", "", artifact_directory)
  plot_width_in <- sub("^PLOT_WIDTH:", "", plot_width_in)
  plot_height_in <- sub("^PLOT_HEIGHT:", "", plot_height_in)
  plot_dpi <- sub("^PLOT_DPI:", "", plot_dpi)
  df_render <- !identical(sub("^DF_RENDER:", "", df_render_line), "0")
  df_max_rows <- suppressWarnings(as.integer(sub("^DF_MAX_ROWS:", "", df_max_rows_line)))
  if (!is.finite(df_max_rows) || df_max_rows < 1) {
    df_max_rows <- 50
  }
  df_max_columns <- suppressWarnings(as.integer(sub("^DF_MAX_COLUMNS:", "", df_max_columns_line)))
  if (!is.finite(df_max_columns) || df_max_columns < 1) {
    df_max_columns <- 50
  }
  code_count <- suppressWarnings(as.integer(sub("^CODE_COUNT:", "", code_count_line)))
  if (!is.finite(code_count) || code_count < 0) {
    code_count <- 0L
  }

  code_lines <- character()
  if (code_count > 0) {
    for (index in seq_len(code_count)) {
      line <- readLines(con = stdin(), n = 1, warn = FALSE)
      if (length(line) == 0) {
        break
      }
      code_lines <- c(code_lines, rmd_notebooks_decode_line(sub("^LINE:", "", line)))
    }
  }

  command_end <- readLines(con = stdin(), n = 1, warn = FALSE)
  if (length(command_end) == 0 || !identical(command_end, "RMD_NOTEBOOKS_END")) {
    next
  }

  result <- rmd_notebooks_execute(
    paste(code_lines, collapse = "\n"),
    rmd_notebooks_decode_line(working_directory),
    rmd_notebooks_decode_line(artifact_directory),
    suppressWarnings(as.numeric(plot_width_in)),
    suppressWarnings(as.numeric(plot_height_in)),
    suppressWarnings(as.numeric(plot_dpi)),
    df_render,
    df_max_rows,
    df_max_columns
  )

  cat("RMD_NOTEBOOKS_RESULT_START\n")
  cat(sprintf("SUCCESS:%s\n", if (result$success) "1" else "0"))
  cat(sprintf("STARTED_AT:%s\n", result$started_at))
  cat(sprintf("FINISHED_AT:%s\n", result$finished_at))
  rmd_notebooks_emit_section("STDOUT", result$stdout)
  rmd_notebooks_emit_section("STDERR", result$stderr)
  rmd_notebooks_emit_section("HTML", result$html)
  rmd_notebooks_emit_section("MARKDOWN", result$markdown)
  rmd_notebooks_emit_section("PLOTS", result$plots)
  cat("RMD_NOTEBOOKS_RESULT_END\n")
  flush.console()
}
})
