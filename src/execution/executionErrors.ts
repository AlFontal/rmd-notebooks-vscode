export class InteractiveExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InteractiveExecutionError";
  }
}
