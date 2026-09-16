export type DependencyStrategy = "host" | "inline" | "extension" | "replace";

export interface HostDependencyDecision {
  strategy: "host";
  packageName: string;
  globalName: string;
}

export interface InlineDependencyDecision {
  strategy: "inline";
  packageName: string;
}

export interface ExtensionDependencyDecision {
  strategy: "extension";
  packageName: string;
  libraryId: string;
  globalName: string;
}

export interface ReplaceDependencyDecision {
  strategy: "replace";
  packageName: string;
  reason: string;
  alternatives?: string[];
}

export type DependencyDecision =
  | HostDependencyDecision
  | InlineDependencyDecision
  | ExtensionDependencyDecision
  | ReplaceDependencyDecision;
