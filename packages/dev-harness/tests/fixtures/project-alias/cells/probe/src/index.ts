/**
 * The Cell entry for the harness's project-alias fixture. It imports the alias by name.
 *
 * Imported through the alias rather than a relative path on purpose: that is the only shape whose
 * resolution the dev server and the Cell build could disagree about, and disagreement is the defect
 * Under test.
 */
import { WHICH } from "@app/shared/thing";

export function App() {
  return WHICH;
}
