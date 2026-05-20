#!/usr/bin/env Rscript

options(repos = c(CRAN = "https://cloud.r-project.org"))

project_root <- tempfile("rmd-notebooks-renv-smoke-", tmpdir = Sys.getenv("TMPDIR", tempdir()))
bootstrap_library <- file.path(project_root, "bootstrap-library")
child_user_library <- file.path(project_root, "child-user-library")
package_name <- paste0("rmdrenvsmoke", Sys.getpid())
keep_project <- identical(Sys.getenv("RMD_NOTEBOOKS_KEEP_RENV_SMOKE"), "1")

dir.create(project_root, recursive = TRUE)
dir.create(bootstrap_library)
dir.create(child_user_library)

if (!keep_project) {
  on.exit(unlink(project_root, recursive = TRUE, force = TRUE), add = TRUE)
}

message("Rmd Notebooks renv startup smoke")
message("Project: ", project_root)

.libPaths(c(bootstrap_library, .libPaths()))

if (!requireNamespace("renv", quietly = TRUE)) {
  message("Installing renv into a temporary bootstrap library...")
  install.packages("renv", lib = bootstrap_library, quiet = TRUE)
}

setwd(project_root)
renv::init(bare = TRUE, restart = FALSE)

package_root <- file.path(project_root, package_name)
dir.create(file.path(package_root, "R"), recursive = TRUE)
writeLines(
  c(
    paste0("Package: ", package_name),
    "Version: 0.0.1",
    "Title: Rmd Notebooks renv Smoke Package",
    "Description: Local package used by the Rmd Notebooks renv startup smoke test.",
    "License: MIT",
    "Encoding: UTF-8"
  ),
  file.path(package_root, "DESCRIPTION")
)
writeLines("export(smoke_value)", file.path(package_root, "NAMESPACE"))
writeLines("smoke_value <- function() 'renv smoke package loaded'", file.path(package_root, "R", "smoke.R"))

renv::install(package_root, prompt = FALSE)

# Avoid leaking parent startup state into the child R processes.
Sys.unsetenv(c("RENV_PROJECT", "RENV_PROFILE", "RENV_ACTIVATE_PROJECT", "R_PROFILE", "R_PROFILE_USER"))

check_code <- paste(
  sprintf("package_name <- '%s'", package_name),
  "libpath_has_renv <- any(grepl('renv/library', .libPaths(), fixed = TRUE))",
  "package_available <- requireNamespace(package_name, quietly = TRUE)",
  "cat('LIBPATH_HAS_RENV=', libpath_has_renv, '\\n', sep = '')",
  "cat('SMOKE_PACKAGE_AVAILABLE=', package_available, '\\n', sep = '')",
  "if (package_available) {",
  "  cat('SMOKE_PACKAGE_VALUE=', getExportedValue(package_name, 'smoke_value')(), '\\n', sep = '')",
  "}",
  sep = "\n"
)

format_args <- function(args) {
  if (length(args) == 0) {
    return("[]")
  }

  paste0("[", paste(sprintf("\"%s\"", args), collapse = ", "), "]")
}

cases <- list(
  list(
    label = "inline default",
    config_args = c("--slave"),
    process_args = c("--slave"),
    startup_directory = project_root,
    expect_renv = TRUE,
    expect_package = TRUE
  ),
  list(
    label = "inline isolated",
    config_args = c("--slave", "--vanilla"),
    process_args = c("--slave", "--vanilla"),
    startup_directory = project_root,
    expect_renv = FALSE,
    expect_package = FALSE
  ),
  list(
    label = "terminal default",
    config_args = c("--vanilla"),
    process_args = c("--vanilla"),
    startup_directory = project_root,
    expect_renv = FALSE,
    expect_package = FALSE
  ),
  list(
    label = "terminal empty args",
    config_args = character(),
    process_args = c("--no-save"),
    startup_directory = project_root,
    expect_renv = TRUE,
    expect_package = TRUE,
    note = "non-interactive harness adds --no-save; a real VS Code terminal uses no args"
  )
)

failures <- character()

for (case in cases) {
  previous_directory <- getwd()
  setwd(case$startup_directory)
  output <- system2(
    "env",
    args = c(
      "-u",
      "R_PROFILE",
      "-u",
      "R_PROFILE_USER",
      "-u",
      "R_ENVIRON",
      "-u",
      "R_ENVIRON_USER",
      "R",
      case$process_args
    ),
    input = check_code,
    stdout = TRUE,
    stderr = TRUE,
    env = c(
      paste0("R_LIBS_USER=", child_user_library),
      "R_LIBS=",
      "R_LIBS_SITE="
    )
  )
  setwd(previous_directory)
  status <- attr(output, "status")
  if (is.null(status)) {
    status <- 0
  }

  has_renv <- any(grepl("LIBPATH_HAS_RENV=TRUE", output, fixed = TRUE))
  has_package <- any(grepl("SMOKE_PACKAGE_AVAILABLE=TRUE", output, fixed = TRUE))
  args_label <- format_args(case$config_args)
  note <- if (!is.null(case$note)) paste0(" (", case$note, ")") else ""

  message("")
  message(case$label, ": ", args_label, note)
  message("  R exited with status: ", status)
  message("  renv library active: ", has_renv)
  message("  smoke package loadable: ", has_package)

  if (status != 0) {
    failures <- c(failures, sprintf("%s exited with status %s", case$label, status))
    message(paste(paste0("  ", output), collapse = "\n"))
    next
  }

  if (!identical(has_renv, case$expect_renv)) {
    failures <- c(
      failures,
      sprintf("%s expected renv active=%s but got %s", case$label, case$expect_renv, has_renv)
    )
  }

  if (!identical(has_package, case$expect_package)) {
    failures <- c(
      failures,
      sprintf("%s expected smoke package loadable=%s but got %s", case$label, case$expect_package, has_package)
    )
  }
}

if (length(failures) > 0) {
  message("")
  message("renv startup smoke failed:")
  message(paste(paste0("- ", failures), collapse = "\n"))
  if (keep_project) {
    message("Project kept at: ", project_root)
  } else {
    message("Set RMD_NOTEBOOKS_KEEP_RENV_SMOKE=1 to keep the temp project for debugging.")
  }
  quit(status = 1)
}

message("")
message("renv startup smoke passed.")
if (keep_project) {
  message("Project kept at: ", project_root)
}
