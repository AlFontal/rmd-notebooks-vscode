import * as vscode from "vscode";
import {
  R_EXTENSION_ID,
  R_EXTENSION_RECOMMENDATION_STATE_KEY,
  RExtensionRecommendationState,
  shouldRecommendRExtension,
} from "./rExtensionRecommendationState";

const INSTALL = "Install";
const NOT_NOW = "Not now";
const DONT_ASK_AGAIN = "Don't ask again";

export async function maybeRecommendRExtension(
  context: vscode.ExtensionContext,
): Promise<void> {
  const state = context.globalState.get<RExtensionRecommendationState>(
    R_EXTENSION_RECOMMENDATION_STATE_KEY,
  );
  const isInstalled =
    vscode.extensions.getExtension(R_EXTENSION_ID) !== undefined;

  if (!shouldRecommendRExtension(vscode.env, isInstalled, state)) {
    return;
  }

  const selection = await vscode.window.showInformationMessage(
    "Rmd Notebooks: install the R extension for VS Code workspace viewer integration.",
    INSTALL,
    NOT_NOW,
    DONT_ASK_AGAIN,
  );

  if (selection === INSTALL) {
    await context.globalState.update(
      R_EXTENSION_RECOMMENDATION_STATE_KEY,
      "installed",
    );
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        R_EXTENSION_ID,
      );
    } catch (error) {
      await context.globalState.update(
        R_EXTENSION_RECOMMENDATION_STATE_KEY,
        undefined,
      );
      void vscode.window.showWarningMessage(
        `Rmd Notebooks: could not install the R extension automatically. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  await context.globalState.update(
    R_EXTENSION_RECOMMENDATION_STATE_KEY,
    selection === DONT_ASK_AGAIN ? "never" : "dismissed",
  );
}
