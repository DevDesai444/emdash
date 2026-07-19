// vite-node config for the bench harness. Reuses the app's vitest alias map
// (same @main/@shared/@emdash/* wiring the tests get) and swaps 'electron' for
// the shim so main-process modules load under a plain Node-style runtime.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig from '../../vitest.config';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const baseAlias =
  (vitestConfig as { resolve?: { alias?: Record<string, string> } }).resolve?.alias ?? {};

export default {
  resolve: {
    alias: {
      ...baseAlias,
      electron: path.join(benchDir, 'shims', 'electron.ts'),
    },
  },
};
