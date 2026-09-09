import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    nitro({
      rollupConfig: { external: [/^@sentry\//] },
      // Cover thumbnails are written at runtime onto the Hetzner volume, so
      // they cannot be build-time public assets; this serves them from disk.
      handlers: [
        {
          route: '/covers/**',
          handler: fileURLToPath(new URL('./src/server/coverHandler.ts', import.meta.url)),
        },
      ],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
