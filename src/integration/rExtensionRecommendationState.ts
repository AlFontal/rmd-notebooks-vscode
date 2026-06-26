export const R_EXTENSION_ID = "REditorSupport.r";
export const R_EXTENSION_RECOMMENDATION_STATE_KEY = "rmdNotebooks.rExtensionRecommendationState";

export type RExtensionRecommendationState = "installed" | "dismissed" | "never";

export interface HostIdentity {
  appName: string;
  uriScheme: string;
}

export function isPositronHost(host: HostIdentity): boolean {
  return `${host.appName} ${host.uriScheme}`.toLowerCase().includes("positron");
}

export function shouldRecommendRExtension(
  host: HostIdentity,
  isRExtensionInstalled: boolean,
  state: RExtensionRecommendationState | undefined
): boolean {
  return !isRExtensionInstalled && !isPositronHost(host) && state === undefined;
}
