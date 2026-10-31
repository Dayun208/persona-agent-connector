import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * vitest 配置。
 * 这里显式 alias 到各包的 src, 避免 vite 把 workspace 包当成外部依赖去 require .ts。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@pasc/core': resolve(process.cwd(), 'packages/core/src/index.ts'),
      '@pasc/napcat': resolve(process.cwd(), 'packages/napcat/src/index.ts'),
      '@pasc/agent': resolve(process.cwd(), 'packages/agent/src/index.ts'),
      '@pasc/server': resolve(process.cwd(), 'packages/server/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // vite 5 的内置模块表里没有 node:sqlite, 不声明的话会被当成普通依赖去解析
    server: { deps: { external: ['node:sqlite'] } },
    environment: 'node',
    testTimeout: 10_000,
  },
});
