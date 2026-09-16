import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

export interface CellTarget {
  pageName: string;
  cell: string;
}

export interface SyncCellInput {
  target: CellTarget;
  artifact: CompileCellResult;
}

export async function syncCell(_input: SyncCellInput): Promise<void> {
  throw new Error("Forguncy MCP synchronization is not implemented yet.");
}
