state_env <- new.env(parent = globalenv())

options(menu.graphics = FALSE)

rmd_notebooks_emit_section <- function(name, lines) {
  cat(sprintf("SECTION:%s:START\n", name))
  if (length(lines) > 0) {
    for (line in lines) {
      cat(line, "\n", sep = "")
    }
  }
  cat(sprintf("SECTION:%s:END\n", name))
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
  output_connection <- get0("active_stdout_connection", envir = state_env, inherits = FALSE)
  message_connection <- get0("active_stderr_connection", envir = state_env, inherits = FALSE)
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
    "SECTION:TITLE:START",
    if (!is.null(title) && nzchar(title)) title else character(),
    "SECTION:TITLE:END",
    "SECTION:PROMPT:START",
    prompt,
    "SECTION:PROMPT:END",
    "SECTION:CHOICE_LABELS:START",
    choice_labels,
    "SECTION:CHOICE_LABELS:END",
    "SECTION:CHOICE_VALUES:START",
    choice_values,
    "SECTION:CHOICE_VALUES:END",
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

rmd_notebooks_execute <- function(code, working_directory, artifact_directory, plot_width_in, plot_height_in, plot_dpi) {
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
  stdout_connection <- textConnection("stdout_buffer", "w", local = TRUE)
  stderr_connection <- textConnection("stderr_buffer", "w", local = TRUE)
  assign("active_stdout_connection", stdout_connection, envir = state_env)
  assign("active_stderr_connection", stderr_connection, envir = state_env)
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
        result <- withVisible(eval(expression, envir = state_env))
        if (result$visible && !is.null(result$value)) {
          html_output <- rmd_notebooks_render_html(result$value)
          if (!is.null(html_output)) {
            html_buffer <- c(html_buffer, html_output)
          } else {
            print(result$value)
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
  })

  grDevices::dev.off()
  sink(type = "message")
  sink()
  close(stdout_connection)
  close(stderr_connection)
  rm(list = c("active_stdout_connection", "active_stderr_connection"), envir = state_env)

  list(
    success = success,
    started_at = started_at,
    finished_at = as.numeric(Sys.time()) * 1000,
    stdout = stdout_buffer,
    stderr = stderr_buffer,
    html = html_buffer,
    plots = rmd_notebooks_collect_plot_paths(artifact_directory, started_at)
  )
}

assign("rmd_notebooks_html", function(html) {
  structure(list(html = paste(html, collapse = "\n")), class = "rmd_notebooks_html")
}, envir = state_env)

assign("inline_chunks_html", get("rmd_notebooks_html", envir = state_env), envir = state_env)
assign("readline", rmd_notebooks_readline, envir = state_env)
assign("menu", rmd_notebooks_menu, envir = state_env)
assign("askYesNo", rmd_notebooks_ask_yes_no, envir = state_env)

rmd_notebooks_patch_binding(baseenv(), "readline", rmd_notebooks_readline)
rmd_notebooks_patch_binding(asNamespace("utils"), "menu", rmd_notebooks_menu)
rmd_notebooks_patch_binding(asNamespace("utils"), "askYesNo", rmd_notebooks_ask_yes_no)

cat("RMD_NOTEBOOKS_READY\n")
flush.console()

repeat {
  command <- readLines(con = stdin(), n = 1, warn = FALSE)
  if (length(command) == 0) {
    break
  }

  if (!identical(command, "RMD_NOTEBOOKS_COMMAND_V1")) {
    next
  }

  working_directory <- readLines(con = stdin(), n = 1, warn = FALSE)
  artifact_directory <- readLines(con = stdin(), n = 1, warn = FALSE)
  plot_width_in <- readLines(con = stdin(), n = 1, warn = FALSE)
  plot_height_in <- readLines(con = stdin(), n = 1, warn = FALSE)
  plot_dpi <- readLines(con = stdin(), n = 1, warn = FALSE)
  code_lines <- character()

  repeat {
    line <- readLines(con = stdin(), n = 1, warn = FALSE)
    if (length(line) == 0 || identical(line, "RMD_NOTEBOOKS_END")) {
      break
    }
    code_lines <- c(code_lines, line)
  }

  result <- rmd_notebooks_execute(
    paste(code_lines, collapse = "\n"),
    working_directory,
    artifact_directory,
    suppressWarnings(as.numeric(plot_width_in)),
    suppressWarnings(as.numeric(plot_height_in)),
    suppressWarnings(as.numeric(plot_dpi))
  )

  cat("RMD_NOTEBOOKS_RESULT_START\n")
  cat(sprintf("SUCCESS:%s\n", if (result$success) "1" else "0"))
  cat(sprintf("STARTED_AT:%s\n", result$started_at))
  cat(sprintf("FINISHED_AT:%s\n", result$finished_at))
  rmd_notebooks_emit_section("STDOUT", result$stdout)
  rmd_notebooks_emit_section("STDERR", result$stderr)
  rmd_notebooks_emit_section("HTML", result$html)
  rmd_notebooks_emit_section("PLOTS", result$plots)
  cat("RMD_NOTEBOOKS_RESULT_END\n")
  flush.console()
}
