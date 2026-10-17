import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The development server needs inline scripts (React's refresh preamble) and a
 * websocket to itself; the shipped build needs neither. So the shipped page gets
 * a policy without them: no inline script can run in the window that holds the
 * whole app's bridge, whatever text a downloaded title manages to smuggle in.
 */
function strictCsp(): Plugin {
  return {
    name: 'strict-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /content="default-src[^"]*"/,
        `content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; media-src 'self' aiomedia:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"`
      )
    },
  }
}

// base: './' so the production build works when loaded over file:// from Electron.
export default defineConfig({
  base: './',
  plugins: [react(), strictCsp()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
