import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import manifest from './src/manifest';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  // @crxjs/vite-plugin 在 dev 模式给 popup 注入 @vite/client 做 HMR，但 popup 跑在
  // chrome-extension:// 协议下 location.port 为空，导致 @vite/client 拼出
  // ws://localhost:undefined/ 非法 URL（issue #648/#746）。显式锁定端口让 HMR 客户端能命中。
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
      host: 'localhost'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
