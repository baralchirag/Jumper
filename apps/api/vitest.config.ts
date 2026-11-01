import { defineConfig } from 'vitest/config';

// Integration tests share one test database, so files run one after another.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000 } });
