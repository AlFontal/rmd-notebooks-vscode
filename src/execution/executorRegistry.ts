import { Executor } from "./executorTypes";

export class ExecutorRegistry {
  private readonly executors = new Map<string, Executor>();

  public register(executor: Executor): void {
    this.executors.set(executor.language.toLowerCase(), executor);
  }

  public get(language: string): Executor | undefined {
    const normalized = language.toLowerCase();
    return this.executors.get(normalized) ?? [...this.executors.values()].find((executor) => executor.canHandle(normalized));
  }

  public all(): Executor[] {
    return [...this.executors.values()];
  }
}
