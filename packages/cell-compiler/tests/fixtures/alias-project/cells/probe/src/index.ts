/**
 * The Cell entry for #97's cross-path fixture. It imports the project alias by name.
 *
 * Deliberately imports through the alias rather than a relative path, because that is the only
 * shape whose resolution the two engines could disagree about. A relative import resolves the same
 * way everywhere and would make the cross-path test pass without testing anything.
 */
import { WHICH } from "@app/shared/thing";

export function App() {
  return WHICH;
}
