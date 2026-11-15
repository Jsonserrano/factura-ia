/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite'

/** pdf-lib trae el carácter U+FFFD literal en cadenas: se escapa para que el HTML sea UTF-8 limpio. */
const escaparFFFD = (): Plugin => ({
  name: 'escapar-fffd',
  enforce: 'post',
  generateBundle(_o, bundle) {
    for (const f of Object.values(bundle)) {
      if (f.type === 'asset' && typeof f.source === 'string') f.source = f.source.replaceAll('\uFFFD', '\\uFFFD')
      if (f.type === 'chunk') f.code = f.code.replaceAll('\uFFFD', '\\uFFFD')
    }
  },
})

export default defineConfig({
  // GitHub Pages sirve el sitio en /<repo>/: rutas relativas para que funcione en cualquier carpeta
  base: './',
  plugins: [viteSingleFile(), escaparFFFD()],
  server: {
    // en desarrollo, /api va al backend Express
    proxy: { '/api': 'http://localhost:3001' },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { include: ['src/calc.ts', 'src/cufe.ts', 'src/ai.ts', 'src/ubl.ts', 'server/**'] },
  },
})
