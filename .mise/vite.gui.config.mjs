// Builds a package's `src/gui.tsx` into `gui-experimental.cjs`. `.mise/bundle.ts`
// runs it under Node with the paths in the environment, because Vite fails
// under Bun.
import { gui } from '@opencode/plugin/gui/vite';
import process from 'node:process';
import { defineConfig } from 'vite';

const entry = process.env.GUI_ENTRY;
const outFile = process.env.GUI_OUT;
if (!entry || !outFile) throw new Error('GUI_ENTRY and GUI_OUT must be set');

export default defineConfig({
  logLevel: 'warn',
  // Solid's plugin has compiled the JSX by the time esbuild strips the types.
  // This only lets esbuild accept the file's `@jsxImportSource` pragma.
  esbuild: { jsx: 'automatic' },
  build: { sourcemap: process.env.GUI_SOURCEMAP ? 'inline' : false },
  plugins: [gui({ entry, outFile })],
});
