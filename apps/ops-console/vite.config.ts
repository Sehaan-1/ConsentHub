import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const bffUrl = loadEnv(mode, process.cwd(), '').BFF_URL ?? 'http://127.0.0.1:3001';

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5174,
      proxy: {
        '/api': {
          target: bffUrl,
          changeOrigin: true
        }
      }
    }
  };
});
