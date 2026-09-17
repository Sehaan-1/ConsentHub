import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Inside docker compose the BFF is reachable as http://bff:4000 (set via
  // the BFF_URL environment variable); outside it, the local BFF on 4000.
  // The browser only ever calls same-origin /api (proxied here), so no
  // localhost/backend host ever appears in browser code.
  const bffUrl = loadEnv(mode, process.cwd(), '').BFF_URL ?? 'http://127.0.0.1:4000';

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      // Accept any Host header so the dev server also works behind a
      // proxied/preview hostname (issue #8).
      allowedHosts: true,
      port: 5173,
      proxy: {
        '/api': {
          target: bffUrl,
          changeOrigin: true
        }
      }
    }
  };
});
