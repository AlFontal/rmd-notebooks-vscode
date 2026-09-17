import { ChunkOutputStatus } from "../document/chunkTypes";

export type ExecutionSurface = "notebook" | "editor";
export type RevealMode = "always" | "errors" | "never";
export type OutputPolicyEvent = "started" | ChunkOutputStatus;

export interface OutputPolicy {
  reveal: boolean;
  showGenericError: boolean;
}

export function getOutputPolicy(
  surface: ExecutionSurface,
  revealMode: RevealMode,
  event: OutputPolicyEvent
): OutputPolicy {
  if (surface === "notebook") {
    return { reveal: false, showGenericError: false };
  }

  return {
    reveal: revealMode === "always" || (revealMode === "errors" && event === "error"),
    showGenericError: event === "error"
  };
}
