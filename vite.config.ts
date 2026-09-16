import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    sourcemap: false,
  },
  lint: {
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
});
