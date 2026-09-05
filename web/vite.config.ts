import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Without this, Vite binds only to the IPv6 loopback ([::1]) on some
  // Windows setups — if the browser/OS resolves "localhost" to 127.0.0.1
  // first, it can't reach the dev server at all. `host: true` binds every
  // interface (0.0.0.0 + ::), so both localhost and 127.0.0.1 work.
  server: {
    host: true,
  },
  // Second/third entry points for standalone internal pages (admin.html /
  // src/admin/*, discovery.html / src/discovery/*) — not linked from the
  // public app, each its own small bundle.
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin.html',
        discovery: 'discovery.html',
      },
    },
  },
});
