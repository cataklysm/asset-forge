import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: ['test/renderer/**', '**/node_modules/**'],
          globalSetup: ['test/global-setup.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['test/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['test/renderer/setup.ts'],
        },
      },
    ],
  },
});
