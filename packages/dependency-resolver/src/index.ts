import type { DependencyDecision } from "@forguncy-react-workspace/core";

export interface ResolveDependencyInput {
  packageName: string;
  version?: string;
}

export async function resolveDependency(_input: ResolveDependencyInput): Promise<DependencyDecision> {
  throw new Error("Dependency resolution is not implemented yet. The implementation will be driven by a GitHub Spec Issue and Agent Skill.");
}
