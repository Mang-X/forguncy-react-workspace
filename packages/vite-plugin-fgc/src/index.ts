export interface ForguncyPluginOptions {
  mode?: "cell";
}

export function forguncy(_options: ForguncyPluginOptions = {}) {
  return {
    name: "forguncy-react-workspace",
  };
}
