import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    sourcemap: false,
  },
  check: {
    fmt: false,
  },
  lint: {
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
});
