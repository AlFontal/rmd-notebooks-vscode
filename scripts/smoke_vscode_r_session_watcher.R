#!/usr/bin/env Rscript

options(repos = c(CRAN = "https://cloud.r-project.org"))

repo_root <- normalizePath(getwd(), mustWork = TRUE)
session_script <- normalizePath(file.path(repo_root, "media", "r", "rmd_notebooks_session.R"), mustWork = TRUE)
vscode_r_init <- file.path(path.expand("~"), ".vscode-R", "init.R")

if (!file.exists(vscode_r_init)) {
  stop("Could not find ~/.vscode-R/init.R. Open VS Code with the vscode-R extension once before running this smoke test.")
}

missing_packages <- c("jsonlite", "rlang")[!vapply(c("jsonlite", "rlang"), requireNamespace, logical(1), quietly = TRUE)]
if (length(missing_packages) > 0) {
  stop("Missing R package(s) required by vscode-R session watcher: ", toString(missing_packages))
}

watcher_dir <- tempfile("rmd-notebooks-vscode-r-watcher-")
artifact_dir <- tempfile("rmd-notebooks-vscode-r-artifacts-")
dir.create(watcher_dir, recursive = TRUE)
dir.create(artifact_dir, recursive = TRUE)
on.exit(unlink(c(watcher_dir, artifact_dir), recursive = TRUE, force = TRUE), add = TRUE)

encode <- function(value) {
  utils::URLencode(enc2utf8(value), reserved = TRUE)
}

protocol_command <- function(code) {
  c(
    "RMD_NOTEBOOKS_COMMAND_V2",
    paste0("WORKDIR:", encode(repo_root)),
    paste0("ARTIFACT_DIR:", encode(artifact_dir)),
    "PLOT_WIDTH:",
    "PLOT_HEIGHT:",
    "PLOT_DPI:",
    "DF_RENDER:1",
    "DF_MAX_ROWS:50",
    "DF_MAX_COLUMNS:50",
    paste0("CODE_COUNT:", length(code)),
    paste0("LINE:", vapply(code, encode, character(1), USE.NAMES = FALSE)),
    "RMD_NOTEBOOKS_END"
  )
}

read_workspace_code <- c(
  "cat('ATTACHED=', 'tools:vscode' %in% search(), '\\n', sep = '')",
  paste(
    "cat('WORKSPACE=',",
    "if (file.exists(file.path(tempdir(), 'vscode-R', 'workspace.json')))",
    "paste(readLines(file.path(tempdir(), 'vscode-R', 'workspace.json'), warn = FALSE), collapse = '')",
    "else 'MISSING', '\\n', sep = '')"
  )
)

input <- c(
  sprintf("source('%s')", gsub("'", "\\\\'", session_script)),
  protocol_command(c(
    "x <- 42",
    "df <- data.frame(a = 1:3, b = letters[1:3])"
  )),
  protocol_command(read_workspace_code)
)

output <- system2(
  "env",
  args = c(
    "RMD_NOTEBOOKS_SOURCE_VSCODE_R_INIT=1",
    paste0("VSCODE_WATCHER_DIR=", watcher_dir),
    "R",
    "--slave"
  ),
  input = input,
  stdout = TRUE,
  stderr = TRUE
)
status <- attr(output, "status")
if (is.null(status)) {
  status <- 0
}
if (status != 0) {
  message(paste(output, collapse = "\n"))
  stop("R protocol process exited with status ", status)
}

decode_line_value <- function(prefix) {
  line <- output[startsWith(output, prefix)][1]
  if (is.na(line)) {
    return(NA_character_)
  }

  utils::URLdecode(sub(prefix, "", line, fixed = TRUE))
}

attached <- decode_line_value("LINE:ATTACHED%3D")
workspace_json <- decode_line_value("LINE:WORKSPACE%3D")

if (!identical(attached, "TRUE")) {
  message(paste(output, collapse = "\n"))
  stop("vscode-R session watcher did not attach to the inline R process.")
}

if (is.na(workspace_json) || identical(workspace_json, "MISSING")) {
  message(paste(output, collapse = "\n"))
  stop("vscode-R workspace.json was not produced.")
}

workspace <- jsonlite::fromJSON(workspace_json, simplifyVector = FALSE)
globalenv <- workspace$globalenv

if (is.null(globalenv$x) || !identical(globalenv$x$type, "double") || !identical(globalenv$x$str, "num 42")) {
  message(workspace_json)
  stop("vscode-R workspace.json does not contain inline variable x.")
}

if (is.null(globalenv$df) || !identical(globalenv$df$class[[1]], "data.frame") || !identical(unlist(globalenv$df$dim), c(3L, 2L))) {
  message(workspace_json)
  stop("vscode-R workspace.json does not contain inline data frame df.")
}

message("vscode-R session watcher smoke passed.")
