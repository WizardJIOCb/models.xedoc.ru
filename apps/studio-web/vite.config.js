import { defineConfig } from 'vite';

export default defineConfig({
  base: '/model-studio/',
  server: {
    proxy: { '/api/model-studio': 'http://127.0.0.1:8095' },
    // Production routes are served by the site's existing reverse proxy.
  },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [
          { name: 'physics', test: /node_modules[\\/]@dimforge/ },
          { name: 'three', test: /node_modules[\\/]three/ },
        ] },
      },
    },
  },
});
