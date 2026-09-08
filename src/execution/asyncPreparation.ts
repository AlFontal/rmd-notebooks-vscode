import { ExecutionCancellationToken } from "./executorTypes";
import { CancelledExecutionError } from "./executionErrors";

/** Bound extension-provider calls, which are not guaranteed to settle. */
export function withTimeout<T>(work: Promise<T>, milliseconds = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Python environment discovery timed out. Try refreshing or enter an executable path.")), milliseconds);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function withCancellation<T>(work: Promise<T>, token: ExecutionCancellationToken): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const listener = token.onCancellationRequested(() => reject(new CancelledExecutionError())) as { dispose?(): void } | undefined;
    if (token.isCancellationRequested) {
      reject(new CancelledExecutionError());
    }
    work.then(resolve, reject).finally(() => listener?.dispose?.());
  });
}
