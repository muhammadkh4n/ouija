import { defineConfig } from 'vitest/config';
import { ouijaSourceAliases } from '../../vitest.shared';

export default defineConfig({
  resolve: { alias: ouijaSourceAliases },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
