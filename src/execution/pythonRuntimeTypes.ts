import { sha1 } from "../util/hash";

export type PythonRuntimeSource = "environment" | "kernelspec" | "configured" | "fallback";

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
  kernelspecNames: string[];
}

export interface PythonRuntimePreference {
  runtime?: PythonLaunchDescriptor;
  yamlRuntime?: PythonLaunchDescriptor;
  mismatch: boolean;
  reason: "persisted" | "yaml" | "active" | "configured" | "fallback" | "none";
}

export interface PythonRuntimePreferenceInput {
  persistedId?: string;
  yamlKernelName?: string;
  activeEnvironmentId?: string;
}

export function controllerIdForRuntime(runtimeId: string): string {
  return `rmd-notebooks-python-${sha1(runtimeId).slice(0, 16)}`;
}

export function normalizePythonPath(value: string, platform = process.platform): string {
  const slashNormalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return platform === "win32" ? slashNormalized.toLowerCase() : slashNormalized;
}

export function mergePythonRuntimes(
  environments: readonly PythonLaunchDescriptor[],
  kernelspecs: readonly PythonLaunchDescriptor[]
): PythonLaunchDescriptor[] {
  const merged = environments.map(cloneRuntime);
  const byPath = new Map(merged.map((runtime) => [normalizePythonPath(runtime.renderPythonPath), runtime]));

  for (const kernelspec of kernelspecs) {
    const existing = byPath.get(normalizePythonPath(kernelspec.renderPythonPath));
    if (existing) {
      existing.kernelspecNames = unique([...existing.kernelspecNames, ...kernelspec.kernelspecNames]);
      continue;
    }
    const cloned = cloneRuntime(kernelspec);
    merged.push(cloned);
    byPath.set(normalizePythonPath(cloned.renderPythonPath), cloned);
  }

  return merged.sort((left, right) => left.label.localeCompare(right.label));
}

export function resolvePythonRuntimePreference(
  runtimes: readonly PythonLaunchDescriptor[],
  input: PythonRuntimePreferenceInput
): PythonRuntimePreference {
  const persisted = input.persistedId ? runtimes.find((runtime) => runtime.id === input.persistedId) : undefined;
  const yamlRuntime = input.yamlKernelName
    ? runtimes.find((runtime) => runtime.kernelspecNames.includes(input.yamlKernelName!))
    : undefined;

  if (persisted) {
    return {
      runtime: persisted,
      yamlRuntime,
      mismatch: Boolean(yamlRuntime && yamlRuntime.id !== persisted.id),
      reason: "persisted"
    };
  }
  if (yamlRuntime) {
    return { runtime: yamlRuntime, yamlRuntime, mismatch: false, reason: "yaml" };
  }

  const active = input.activeEnvironmentId
    ? runtimes.find((runtime) => runtime.environmentId === input.activeEnvironmentId)
    : undefined;
  if (active) {
    return { runtime: active, yamlRuntime, mismatch: false, reason: "active" };
  }

  const configured = runtimes.find((runtime) => runtime.source === "configured");
  if (configured) {
    return { runtime: configured, yamlRuntime, mismatch: false, reason: "configured" };
  }
  const fallback = runtimes.find((runtime) => runtime.source === "fallback");
  return fallback
    ? { runtime: fallback, yamlRuntime, mismatch: false, reason: "fallback" }
    : { runtime: undefined, yamlRuntime, mismatch: false, reason: "none" };
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
      return { runtime, score: scores.every((score) => score >= 0) ? scores.reduce((sum, score) => sum + score, 0) : -1 };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.runtime.label.localeCompare(right.runtime.label))
    .map((entry) => entry.runtime);
}

function cloneRuntime(runtime: PythonLaunchDescriptor): PythonLaunchDescriptor {
  return {
    ...runtime,
    prefixArgs: [...runtime.prefixArgs],
    kernelspecNames: [...runtime.kernelspecNames],
    environmentVariables: runtime.environmentVariables ? { ...runtime.environmentVariables } : undefined
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
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
