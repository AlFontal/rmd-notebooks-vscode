export type PythonRuntimeSource =
  | "environment"
  | "configured"
  | "environmentVariable"
  | "manual"
  | "fallback";

export interface PythonLaunchDescriptor {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  source: PythonRuntimeSource;
  executable: string;
  prefixArgs: string[];
  renderPythonPath: string;
  environmentVariables?: Record<string, string | undefined>;
  environmentId?: string;
}

export interface EnvironmentRuntimeInput {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  executable: string;
  prefixArgs?: string[];
  renderPythonPath: string;
}

export function createEnvironmentRuntime(input: EnvironmentRuntimeInput): PythonLaunchDescriptor {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    detail: input.detail,
    source: "environment",
    executable: input.executable,
    prefixArgs: [...(input.prefixArgs ?? [])],
    renderPythonPath: input.renderPythonPath,
    environmentId: input.id
  };
}

export function normalizePythonPath(value: string, platform = process.platform): string {
  const slashNormalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return platform === "win32" ? slashNormalized.toLowerCase() : slashNormalized;
}

export function filterPythonRuntimes(
  runtimes: readonly PythonLaunchDescriptor[],
  query: string
): PythonLaunchDescriptor[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return [...runtimes];
  }
  return runtimes
    .map((runtime) => {
      const searchable = [runtime.label, runtime.description, runtime.detail, runtime.renderPythonPath]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();
      const scores = terms.map((term) => fuzzyScore(searchable, term));
      return {
        runtime,
        score: scores.every((score) => score >= 0) ? scores.reduce((sum, score) => sum + score, 0) : -1
      };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.runtime.label.localeCompare(right.runtime.label))
    .map((entry) => entry.runtime);
}

function fuzzyScore(value: string, pattern: string): number {
  const substringIndex = value.indexOf(pattern);
  if (substringIndex >= 0) {
    return 1000 - substringIndex - Math.max(0, value.length - pattern.length) * 0.01;
  }
  if (/[^a-z]/.test(pattern)) {
    return -1;
  }
  let patternIndex = 0;
  let firstMatch = -1;
  let previousMatch = -2;
  let consecutive = 0;
  for (let index = 0; index < value.length && patternIndex < pattern.length; index += 1) {
    if (value[index] !== pattern[patternIndex]) {
      continue;
    }
    if (firstMatch < 0) {
      firstMatch = index;
    }
    if (index === previousMatch + 1) {
      consecutive += 1;
    }
    previousMatch = index;
    patternIndex += 1;
  }
  return patternIndex === pattern.length ? 100 + consecutive * 5 - firstMatch : -1;
}
