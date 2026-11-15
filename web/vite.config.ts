import {defineConfig, type Plugin} from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// 把 dist/assets 下的 js/css 全部内联进 index.html。
// WebView2 里以 http://wails.localhost 加载外链 module 脚本偶发被拒（表现为纯白窗口），
// 单文件能彻底规避，exe 也更省事。
function inlineAssets(): Plugin {
  return {
    name: 'inline-assets',
    apply: 'build',
    closeBundle() {
      const dist = path.resolve(__dirname, 'dist')
      const htmlPath = path.join(dist, 'index.html')
      if (!fs.existsSync(htmlPath)) return
      let html = fs.readFileSync(htmlPath, 'utf8')

      html = html.replace(/<script[^>]*src=["'](?:\.\/|\/)?assets\/([^"']+\.js)["'][^>]*><\/script>/g, (_m, f) => {
        const code = fs.readFileSync(path.join(dist, 'assets', f), 'utf8')
        return `<script type="module">\n${code.replace(/<\/script>/g, '<\\/script>')}\n</script>`
      })

      html = html.replace(/<link[^>]*href=["'](?:\.\/|\/)?assets\/([^"']+\.css)["'][^>]*>/g, (_m, f) => {
        const css = fs.readFileSync(path.join(dist, 'assets', f), 'utf8')
        return `<style>\n${css}\n</style>`
      })

      // 图片也内联成 data URI：图标这类小图会超过 assetsInlineLimit 落成独立文件，
      // 而下面会把 assets 目录整个删掉，不内联就会裂图（曾导致侧栏 logo 空白）。
      html = html.replace(/["'](?:.\/|\/)?assets\/([^"']+\.(?:png|jpg|jpeg|svg|gif|webp))["']/g,
        (m: string, f: string) => {
          const fp = path.join(dist, 'assets', f)
          if (!fs.existsSync(fp)) return m
          const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase()
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + (ext === 'svg' ? 'svg+xml' : ext)
          const b64 = fs.readFileSync(fp).toString('base64')
          return `"data:${mime};base64,${b64}"`
        })

      fs.writeFileSync(htmlPath, html)
      const assetsDir = path.join(dist, 'assets')
      if (fs.existsSync(assetsDir)) {
        for (const f of fs.readdirSync(assetsDir)) fs.unlinkSync(path.join(assetsDir, f))
        fs.rmdirSync(assetsDir)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), inlineAssets()],
  // png 走 base64 内联，与 js/css 一起变成单文件，避免 exe 里出现裂图
  build: { target: 'chrome87', minify: false, assetsInlineLimit: 12000 },
  esbuild: { target: 'chrome87', minify: false },
})
