import type { DependencyDecision } from "@forguncy-react-workspace/core";

export interface CompileCellInput {
  entry: string;
  dependencies: DependencyDecision[];
}

export interface CompileCellResult {
  code: string;
  frontendLibraries: Array<{ libraryId: string }>;
}

export async function compileCell(_input: CompileCellInput): Promise<CompileCellResult> {
  throw new Error("Cell compiler is not implemented yet. Track implementation in GitHub Issues.");
}
