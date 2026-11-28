import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Workspace packages export TypeScript source, so they are bundled into main.
const WORKSPACE_PACKAGES = [
  '@assetforge/contracts',
  '@assetforge/core',
  '@assetforge/jobs',
  '@assetforge/media',
  '@assetforge/persistence',
  '@assetforge/providers',
  '@assetforge/storage',
];

const PERSISTENCE_MIGRATIONS = fileURLToPath(new URL('../../packages/persistence/migrations', import.meta.url));

const MAIN_ENTRY = fileURLToPath(new URL('src/main/index.ts', import.meta.url));

// Worker thread entry; built next to index.js as out/main/preview-worker.js.
const PREVIEW_WORKER_ENTRY = fileURLToPath(new URL('../../packages/media/src/preview-worker.ts', import.meta.url));

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
      __ASSETFORGE_DEV_MIGRATIONS_FOLDER__: JSON.stringify(command === 'serve' ? PERSISTENCE_MIGRATIONS : null),
    },
    plugins: command === 'build' ? [copyMigrations()] : [],
    build: {
      // Native modules (better-sqlite3, sharp) must be loaded from node_modules at runtime; ffmpeg-static
      // answers the path of its downloaded binary next to its own file, so it must stay there too.
      externalizeDeps: { exclude: WORKSPACE_PACKAGES, include: ['better-sqlite3', 'sharp', 'ffmpeg-static'] },
      rolldownOptions: {
        input: { index: MAIN_ENTRY, 'preview-worker': PREVIEW_WORKER_ENTRY },
      },
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
    plugins: [react(), tailwindcss()],
  },
}));
