import {defineConfig} from 'vite';

// The dashboard is bundled into the Python package so installs need no Node.
export default defineConfig({
  build: {
    outDir: '../src/plenger/ui',
    emptyOutDir: true,
  },
});
