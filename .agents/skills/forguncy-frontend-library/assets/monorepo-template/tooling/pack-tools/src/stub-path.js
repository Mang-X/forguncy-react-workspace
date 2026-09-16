import { fileURLToPath } from "node:url";

// 宿主 React 桩的唯一副本，供各包的测试通过 hostReactStubPath 引用。
export const hostReactStubPath = fileURLToPath(new URL("./react-stub.mjs", import.meta.url));
