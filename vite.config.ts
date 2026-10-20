import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()],resolve:{alias:process.env.SAS_PUBLIC_EDITION_MODULE?[{find:/^(?:\.\/speech-edition|\.\.\/shared\/speech-edition)\.mjs$/,replacement:process.env.SAS_PUBLIC_EDITION_MODULE}]:[]}, server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3210' } }, build: { outDir: process.env.SAS_PUBLIC_DIST||'dist' } });
