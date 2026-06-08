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
