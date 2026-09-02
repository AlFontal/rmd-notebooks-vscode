export class InteractiveExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InteractiveExecutionError";
  }
}

export class CancelledExecutionError extends Error {
  public constructor(message = "Execution cancelled before it started.") {
    super(message);
    this.name = "CancelledExecutionError";
  }
}

export class MissingIPythonError extends Error {
  public constructor(message = "Python chunks require IPython in the selected environment.") {
    super(message);
    this.name = "MissingIPythonError";
  }
}
