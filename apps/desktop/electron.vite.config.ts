import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Workspace packages export TypeScript source, so they are bundled into main.
const WORKSPACE_PACKAGES = [
  '@assetforge/contracts',
  '@assetforge/core',
  '@assetforge/persistence',
  '@assetforge/storage',
];

const PERSISTENCE_MIGRATIONS = fileURLToPath(
  new URL('../../packages/persistence/migrations', import.meta.url),
);

/** Copies the SQL migrations next to the built main bundle (`out/main/migrations`). */
function copyMigrations(): Plugin {
  return {
    name: 'assetforge:copy-migrations',
    apply: 'build',
    writeBundle(options) {
      if (!options.dir) throw new Error('Main build has no output directory');
      cpSync(PERSISTENCE_MIGRATIONS, `${options.dir}/migrations`, { recursive: true });
    },
  };
}

export default defineConfig(({ command }) => ({
  main: {
    // Dev reads the migrations straight from the persistence package; a build uses the copy.
    define: {
      __ASSETFORGE_DEV_MIGRATIONS_FOLDER__: JSON.stringify(
        command === 'serve' ? PERSISTENCE_MIGRATIONS : null,
      ),
    },
    plugins: command === 'build' ? [copyMigrations()] : [],
    build: {
      // better-sqlite3 is a native module and must be loaded from node_modules at runtime.
      externalizeDeps: { exclude: WORKSPACE_PACKAGES, include: ['better-sqlite3'] },
    },
  },
  preload: {
    build: {
      // A sandboxed preload must be CommonJS and may only require('electron').
      externalizeDeps: false,
      rolldownOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
}));
