export const DEFAULT_INLINE_R_ARGS = ["--slave"] as const;
export const DEFAULT_TERMINAL_R_ARGS = ["--vanilla"] as const;

interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T | undefined;
}

export function getInlineRArgs(configuration: ConfigurationReader): string[] {
  return getConfiguredArgs(configuration, "r.args", DEFAULT_INLINE_R_ARGS);
}

export function getTerminalRArgs(configuration: ConfigurationReader): string[] {
  return getConfiguredArgs(configuration, "r.terminalArgs", DEFAULT_TERMINAL_R_ARGS);
}

function getConfiguredArgs(
  configuration: ConfigurationReader,
  section: string,
  defaultValue: readonly string[]
): string[] {
  const configured = configuration.get<readonly string[]>(section, defaultValue);
  return [...(configured ?? defaultValue)];
}
