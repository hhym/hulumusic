/* 千千静听 .skn 皮肤兼容层（前端）。

   数据来自 Go 侧桥接：
     bridge().SkinPacks()        → 列表（只含名字，不含贴图）
     bridge().DecodeSkinPack(id) → 全量模型（Skin.xml 布局 + BMP data URI）

   这里做三件事：
     1. 把 BMP 里的品红抠成透明（浏览器不支持「颜色键」，得走 canvas）；
     2. 按 Skin.xml 的四元组把控件绝对定位铺出来（像素级还原千千静听窗口）；
     3. 从皮肤里提取配色，生成一套 CSS 变量，套到现有 `.skin` 界面做主题映射。

   注意：.skn 的坐标是「x1,y1,x2,y2」端点，不是宽高。 */

export type TtSkinControl = {
  name: string
  x1: number
  y1: number
  x2: number
  y2: number
  image?: string
  hotImage?: string
  thumbImage?: string
  fillImage?: string
  barImage?: string
  color?: string
  bkgnd?: string
  font?: string
  fontSize?: number
  align?: string
  vertical?: boolean
}

export type TtSkinWindow = {
  name: string
  image: string
  x: number
  y: number
  w: number
  h: number
  controls: TtSkinControl[]
}

export type TtSkin = {
  file: string
  name: string
  author: string
  homepage: string
  transparent: string
  windows: TtSkinWindow[]
  assets: Record<string, string>
}

export type TtSkinPack = {
  id: string
  name: string
  version: string
  author: string
  skins: TtSkin[]
}

const bridge = () => (window as any).go?.main?.App

export async function loadSkinPacks(): Promise<TtSkinPack[]> {
  const app: any = bridge()
  if (!app?.SkinPacks) return []
  try {
    const raw: any = await app.SkinPacks()
    // Wails 会把 (值, error) 包成 [值, 错误]；也兼容直接返回数组的情况
    const v = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export async function decodeSkinPack(id: string): Promise<TtSkinPack | null> {
  const app: any = bridge()
  if (!app?.DecodeSkinPack) return null
  try {
    const raw: any = await app.DecodeSkinPack(id)
    const v = Array.isArray(raw) && raw[0] && raw[0].skins ? raw[0] : raw
    return v && v.skins ? v : null
  } catch {
    return null
  }
}

/* ---------- 1. 抠色缓存 ---------- */

const alphaCache = new Map<string, Promise<string>>()

function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '')
  if (s.length === 3) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]
  }
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/** 把 BMP data URI 里的品红抠成透明，返回 PNG data URI（带缓存）。 */
export function knockOut(dataUri: string, colorKey: string): Promise<string> {
  const key = dataUri.slice(-48) + '|' + colorKey
  const hit = alphaCache.get(key)
  if (hit) return hit
  const job = new Promise<string>(resolve => {
    if (!dataUri) return resolve('')
    const img = new Image()
    img.onload = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = img.naturalWidth
        cv.height = img.naturalHeight
        const cx = cv.getContext('2d')!
        cx.drawImage(img, 0, 0)
        const data = cx.getImageData(0, 0, cv.width, cv.height)
        const [kr, kg, kb] = hexToRgb(colorKey || '#ff00ff')
        const px = data.data
        for (let i = 0; i < px.length; i += 4) {
          // 品红容差放大一点：老皮肤存成 16 位色时会偏移
          if (Math.abs(px[i] - kr) <= 6 && Math.abs(px[i + 1] - kg) <= 6 && Math.abs(px[i + 2] - kb) <= 6) {
            px[i + 3] = 0
          }
        }
        cx.putImageData(data, 0, 0)
        resolve(cv.toDataURL('image/png'))
      } catch {
        resolve(dataUri)
      }
    }
    img.onerror = () => resolve('')
    img.src = dataUri
  })
  alphaCache.set(key, job)
  return job
}

/* ---------- 2. 像素级渲染 ---------- */

export type RenderOptions = {
  /** 只渲染这些控件（默认全部）；用来先做最小可用窗口 */
  only?: string[]
  /** 点击回调：控件名 → 处理 */
  onControl?: (name: string) => void
  /** 缩放倍数，默认 1（原尺寸） */
  scale?: number
  /** 按宽度自适应（缩略图用），优先于 scale */
  fitWidth?: number
}

const BUTTON_NAMES = new Set(['play', 'pause', 'stop', 'prev', 'next', 'mute', 'open', 'browser', 'lyric',
  'equalizer', 'playlist', 'minimize', 'minimode', 'exit', 'ontop', 'desklrc', 'close', 'enabled', 'profile', 'reset'])

/** 渲染一个 .skn 窗口（默认主窗口）到容器里，返回清理函数。 */
export function renderTtSkinWindow(
  container: HTMLElement,
  skin: TtSkin,
  windowName = 'player',
  opts: RenderOptions = {},
): () => void {
  const win = skin.windows.find(w => w.name === windowName) || skin.windows[0]
  if (!win) return () => {}
  const base = skin.assets[win.image] || ''
  const scale = opts.scale ?? 1

  container.innerHTML = ''
  container.style.position = 'relative'
  container.style.width = '0px'
  container.style.height = '0px'
  container.style.overflow = 'hidden'

  const stage = document.createElement('div')
  stage.className = 'ttskn-stage'
  stage.style.cssText =
    `position:relative;transform:scale(${scale});transform-origin:top left;` +
    `width:0;height:0;image-rendering:pixelated;`
  container.appendChild(stage)

  const cleanup: Array<() => void> = []

  // 背景：先按底色铺，再把背景图叠上去（抠色后透明区露出底色）
  const bg = document.createElement('div')
  bg.style.cssText = `position:absolute;left:0;top:0;background:${skin.assets[win.image] ? 'transparent' : '#222'};`
  stage.appendChild(bg)
  knockOut(base, skin.transparent).then(png => {
    if (!png) return
    const img = new Image()
    img.src = png
    img.style.cssText = 'position:absolute;left:0;top:0;display:block;'
    img.onload = () => {
      const sc = opts.fitWidth ? Math.min(opts.fitWidth / img.naturalWidth, 1) : scale
      stage.style.transform = `scale(${sc})`
      stage.style.width = img.naturalWidth + 'px'
      stage.style.height = img.naturalHeight + 'px'
      container.style.width = img.naturalWidth * sc + 'px'
      container.style.height = img.naturalHeight * sc + 'px'
    }
    stage.appendChild(img)
  })

  for (const c of win.controls) {
    if (opts.only && !opts.only.includes(c.name)) continue
    const w = Math.max(1, c.x2 - c.x1)
    const h = Math.max(1, c.y2 - c.y1)
    const el = BUTTON_NAMES.has(c.name) ? document.createElement('button') : document.createElement('div')
    el.dataset.ttControl = c.name
    el.style.cssText =
      `position:absolute;left:${c.x1}px;top:${c.y1}px;width:${w}px;height:${h}px;` +
      `border:0;padding:0;margin:0;background:transparent;cursor:${BUTTON_NAMES.has(c.name) ? 'pointer' : 'default'};`

    // 按钮：常态贴图 + 悬停贴图（千千静听的热区是 hot_image）
    if (c.image && skin.assets[c.image]) {
      knockOut(skin.assets[c.image], skin.transparent).then(png => {
        if (!png) return
        el.style.backgroundImage = `url(${png})`
        el.style.backgroundSize = '100% 100%'
      })
      if (c.hotImage && skin.assets[c.hotImage]) {
        const enter = () => {
          knockOut(skin.assets[c.hotImage!], skin.transparent).then(png => {
            if (png) el.style.backgroundImage = `url(${png})`
          })
        }
        const leave = () => {
          knockOut(skin.assets[c.image!], skin.transparent).then(png => {
            if (png) el.style.backgroundImage = `url(${png})`
          })
        }
        el.addEventListener('mouseenter', enter)
        el.addEventListener('mouseleave', leave)
        cleanup.push(() => {
          el.removeEventListener('mouseenter', enter)
          el.removeEventListener('mouseleave', leave)
        })
      }
    }

    // 滑杆：滑轨 + 填充 + 滑块
    if (c.barImage && skin.assets[c.barImage]) {
      knockOut(skin.assets[c.barImage], skin.transparent).then(png => {
        if (png) {
          el.style.backgroundImage = `url(${png})`
          el.style.backgroundSize = '100% 100%'
        }
      })
    }
    if (c.fillImage && skin.assets[c.fillImage]) {
      knockOut(skin.assets[c.fillImage], skin.transparent).then(png => {
        if (!png) return
        const fill = document.createElement('div')
        fill.dataset.ttFill = c.name
        fill.style.cssText =
          `position:absolute;left:0;top:0;width:${c.vertical ? '100%' : '50%'};` +
          `height:${c.vertical ? '50%' : '100%'};background:url(${png}) 0 0/100% 100% no-repeat;pointer-events:none;`
        el.appendChild(fill)
      })
    }
    if (c.thumbImage && skin.assets[c.thumbImage]) {
      knockOut(skin.assets[c.thumbImage], skin.transparent).then(png => {
        if (!png) return
        const thumb = document.createElement('div')
        thumb.dataset.ttThumb = c.name
        thumb.style.cssText = c.vertical
          ? `position:absolute;left:0;top:50%;width:100%;background:url(${png}) center/100% auto no-repeat;` +
            `height:${c.y2 - c.y1}px;pointer-events:none;`
          : `position:absolute;left:50%;top:0;height:100%;background:url(${png}) center/auto 100% no-repeat;` +
            `width:${c.x2 - c.x1}px;pointer-events:none;`
        el.appendChild(thumb)
      })
    }

    // 文本区：颜色/字体/对齐都来自皮肤
    if (c.font || c.color || c.bkgnd) {
      el.style.color = c.color || '#ccc'
      el.style.background = c.bkgnd || 'transparent'
      el.style.fontFamily = c.font ? `"${c.font}", monospace` : 'monospace'
      el.style.fontSize = (c.fontSize || 12) + 'px'
      el.style.textAlign = c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left'
      el.style.lineHeight = h + 'px'
      el.style.overflow = 'hidden'
    }
    // LED 数字：贴图是整条数字带，先铺上，运行时用位移滚动
    if (c.name === 'led' && c.image && skin.assets[c.image]) {
      knockOut(skin.assets[c.image], skin.transparent).then(png => {
        if (png) el.style.backgroundImage = `url(${png})`
      })
    }

    if (opts.onControl && BUTTON_NAMES.has(c.name)) {
      const fire = () => opts.onControl!(c.name)
      el.addEventListener('click', fire)
      cleanup.push(() => el.removeEventListener('click', fire))
    }
    stage.appendChild(el)
  }

  return () => {
    cleanup.forEach(fn => fn())
    container.innerHTML = ''
  }
}

/* ---------- 3. 主题映射 ---------- */

/** 从皮肤里抠出的配色（用作 CSS 变量）。 */
export type TtSkinTheme = {
  id: string
  name: string
  accent: string
  bg: string
  fg: string
  panel: string
  windowImage: string
}

function rgbOf(hexLike?: string): [number, number, number] | null {
  if (!hexLike) return null
  const m = hexLike.trim().match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) return null
  return hexToRgb('#' + m[1])
}

/** 千千静听的默认底色，皮肤没写就用它。 */
const FALLBACK = { accent: '#ff9d20', bg: '#1b1b1f', fg: '#ffe6bd', panel: '#2a2a30' }

export function themeOfSkin(skin: TtSkin): TtSkinTheme {
  const win = skin.windows.find(w => w.name === 'player') || skin.windows[0]
  const ctrl = (n: string) => win?.controls.find(c => c.name === n)
  const accent = rgbOf(ctrl('stereo')?.color) || rgbOf(ctrl('info')?.bkgnd) || rgbOf(FALLBACK.accent)!
  const bg = rgbOf(ctrl('status')?.bkgnd) || rgbOf(ctrl('info')?.bkgnd) || rgbOf(FALLBACK.bg)!
  const fg = rgbOf(ctrl('info')?.color) || rgbOf(FALLBACK.fg)!
  const panel = rgbOf(ctrl('status')?.bkgnd) || bg
  const hex = (c: [number, number, number]) => '#' + c.map(x => x.toString(16).padStart(2, '0')).join('')
  return {
    id: 'ttskn-' + skin.file.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase(),
    name: skin.name || skin.file,
    accent: hex(accent),
    bg: hex(bg),
    fg: hex(fg),
    panel: hex(panel),
    windowImage: win?.image || '',
  }
}

/** 生成并注入一套 CSS：`[data-skin="ttskn-xxx"]`。返回样式表 id，便于卸载。 */
export async function applyTtSkinTheme(skin: TtSkin): Promise<string> {
  const t = themeOfSkin(skin)
  const bgPng = t.windowImage && skin.assets[t.windowImage]
    ? await knockOut(skin.assets[t.windowImage], skin.transparent)
    : ''

  const css = `
[data-skin="${t.id}"] {
  --ttskn-accent: ${t.accent};
  --ttskn-bg: ${t.bg};
  --ttskn-fg: ${t.fg};
  --ttskn-panel: ${t.panel};
}
[data-skin="${t.id}"] .sk-panel{
  background: ${bgPng ? `url(${bgPng}) 0 0/100% auto no-repeat, ` : ''}${t.bg};
  color: ${t.fg};
  border-color: ${t.accent};
}
[data-skin="${t.id}"] .sk-title{background:${t.panel};color:${t.fg}}
[data-skin="${t.id}"] .sk-title .sk-time{color:${t.accent}}
[data-skin="${t.id}"] .sk-wb{background:linear-gradient(180deg,${t.accent},${t.panel});color:${t.fg}}
[data-skin="${t.id}"] .sk-line .k{color:${t.accent}}
[data-skin="${t.id}"] .sk-line .v{color:${t.fg}}
[data-skin="${t.id}"] .sk-status{color:${t.accent}}
[data-skin="${t.id}"] .sk-spec{background:${t.bg}}
[data-skin="${t.id}"] .sk-vis{--vis-lo:${t.bg};--vis-mid:${t.accent};--vis-hi:${t.fg}}
`

  const id = 'ttskn-style-' + t.id
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = css
  return t.id
}

/** 切到某套皮肤：注入 CSS 并把 data-skin 指过去。 */
export async function activateTtSkin(skin: TtSkin): Promise<string> {
  const id = await applyTtSkinTheme(skin)
  const root = document.documentElement.querySelector('.app')
  if (root) root.setAttribute('data-skin', id)
  return id
}

/** 恢复成内置皮肤（把 data-skin 交回 App 管理）。 */
export function leaveTtSkin(innerSkin: string) {
  const root = document.documentElement.querySelector('.app')
  if (root) root.setAttribute('data-skin', innerSkin)
}
