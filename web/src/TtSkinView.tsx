/* 像素级千千静听窗口（skin 布局下的第三种视图：ttmode）。

   整套布局在 React 里画，所以是「活的」：播放/暂停换图、进度随播放走、频谱接真实 FFT。
   子窗口（歌词 / 播放列表 / 均衡器）同样用皮肤包里对应的 *_window 底图来画。

   几个从 .skn 里挖出来的事实决定了实现方式：

   1. position 是 x1,y1,x2,y2 端点矩形，宽高要自己减；
   2. 按钮贴图常把「常态 / 悬停 / 按下」拼在一张 BMP 里（横排或竖排），
      所以先量贴图尺寸再按控件矩形切帧——整图铺会把几帧挤进一个按钮，看着像噪点；
   3. led 用的 number.bmp 是 12 个字形（0-9、:、-）并排，按 1/12 位移取字；
   4. transparent_color（多为 #ff00ff）是颜色键，得用 canvas 抠；
   5. 均衡器窗只给了 preamp 一根和 eqfactor 一根，10 段是照 eqfactor 的样子复制排开的。 */

import {useEffect, useMemo, useRef, useState} from 'react'
import {
  decodeSkinPack, knockOut, loadSkinPacks,
  type TtSkin, type TtSkinControl, type TtSkinPack, type TtSkinWindow,
} from './ttskin'
import {type Analysts, bucketEdges} from './visDraw'

const LS_SKIN = 'qqjt-ttskin-file'

/** 一张贴图：抠好色的 PNG + 原始像素尺寸（用来判断里面拼了几帧）。 */
type Tex = {url: string; w: number; h: number}

export type TtSkinViewProps = {
  playing: boolean
  cur: { name: string; artist?: string; album?: string } | null
  pos: number
  dur: number
  volume: number
  // ── 播放控制 ──
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onStop: () => void
  onMute: () => void
  onSeek: (ratio: number) => void
  onVolume: (v: number) => void
  onMini: () => void
  onExit: () => void
  // ── 子窗口要的数据 ──
  /** 打开本地目录（对应 TTPlayer 的「打开」键） */
  onOpen: () => void
  /** 音乐窗（对应 TTPlayer 的「音乐窗」键） */
  onMusicWindow: () => void
  lrc: {time: number; text: string}[]
  lrcIndex: number
  queue: {id: string; name: string; artist?: string}[]
  qIndex: number
  onPick: (i: number) => void
  // ── 均衡器 ──
  eqOn: boolean
  eqGains: number[]
  preamp: number
  onEqGain: (i: number, v: number) => void
  onPreamp: (v: number) => void
  onEqToggle: () => void
  onEqReset: () => void
  /** 声道平衡 -1..1（-1 全左 / 0 居中 / 1 全右） */
  balance: number
  onBalance: (v: number) => void
  /** 立体声扩展强度 0..1 */
  surround: number
  onSurround: (v: number) => void
  /** 主窗口是否置顶 */
  ontop: boolean
  onOntop: () => void
  /** 桌面歌词窗口是否开着 */
  deskLrc: boolean
  onDeskLrc: () => void
  /** 需要时建立音频图并给出分析节点；拿不到就是 null（跨源音源） */
  ensure: () => Promise<Analysts | null>
}

function fmtT(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
}

function measure(uri: string): Promise<{w: number; h: number}> {
  return new Promise((resolve) => {
    const im = new Image()
    im.onload = () => resolve({w: im.naturalWidth, h: im.naturalHeight})
    im.onerror = () => resolve({w: 0, h: 0})
    im.src = uri
  })
}

/* 插件包只解一次：切来切去不该每次重解 2MB 的 zip */
let packCache: {at: number; pack: TtSkinPack | null} = {at: 0, pack: null}

async function getPack(): Promise<TtSkinPack | null> {
  if (packCache.pack && Date.now() - packCache.at < 60_000) return packCache.pack
  try {
    const packs = await loadSkinPacks()
    const first = packs[0]
    if (!first) return null
    const pack = await decodeSkinPack(first.id)
    packCache = {at: Date.now(), pack}
    return pack
  } catch {
    return null
  }
}

/** 把皮肤里所有窗口用到的贴图一次抠完，并量出尺寸。 */
async function prepareAssets(skin: TtSkin): Promise<Record<string, Tex>> {
  const out: Record<string, Tex> = {}
  const need = new Set<string>()
  for (const win of skin.windows) {
    if (win.image) need.add(win.image)
    for (const c of win.controls || []) {
      for (const k of [c.image, c.hotImage, c.thumbImage, c.fillImage, c.barImage]) {
        if (k) need.add(k)
      }
    }
  }
  await Promise.all(
    Array.from(need).map(async (name) => {
      const raw = skin.assets[name]
      if (!raw) return
      // 抠色失败（个别 WebView2 解不了 BMP）就退回原图，宁可留粉底也别整块空白
      const url = (await knockOut(raw, skin.transparent)) || raw
      const {w, h} = await measure(url)
      out[name] = {url, w, h}
    }),
  )
  return out
}

/** 贴图里横向 / 纵向拼了几帧。1 就是单帧。 */
function frameCount(t: Tex | undefined, cw: number, ch: number): {fw: number; fh: number} {
  if (!t || !cw || !ch) return {fw: 1, fh: 1}
  const fw = Math.round(t.w / cw) || 1
  const fh = Math.round(t.h / ch) || 1
  // 只有「横向整除、纵向单帧」这类干净排布才当多帧，否则按单帧整图铺
  if (fw >= 2 && Math.abs(t.w - fw * cw) <= 2 && Math.abs(t.h - ch) <= 2) return {fw, fh: 1}
  if (fh >= 2 && Math.abs(t.h - fh * ch) <= 2 && Math.abs(t.w - cw) <= 2) return {fw: 1, fh}
  return {fw: 1, fh: 1}
}

/** 按钮：按帧切贴图，常态 / 悬停 / 按下各一帧。 */
function Btn(props: {
  c: TtSkinControl
  assets: Record<string, Tex>
  swap?: string
  onClick?: () => void
  title?: string
  active?: boolean
}) {
  const {c, assets, swap} = props
  const w = Math.max(1, c.x2 - c.x1)
  const h = Math.max(1, c.y2 - c.y1)
  const tex = assets[swap || c.image || '']
  const hotTex = assets[c.hotImage || '']
  const frames = frameCount(tex, w, h)
  const hotFrames = frameCount(hotTex, w, h)
  const [state, setState] = useState<'idle' | 'hot' | 'down'>('idle')
  const useHot = state !== 'idle' && hotTex
  const t = useHot ? hotTex : tex
  const f = useHot ? hotFrames : frames
  // 帧序号：常态 0、悬停 1、按下 2（帧不够就退回 0 / 1）
  const count = f.fw > 1 ? f.fw : f.fh
  const idx = state === 'down' ? Math.min(2, count - 1) : state === 'hot' ? Math.min(1, count - 1) : 0
  return (
    <button
      className={'ttskn-btn' + (props.active ? ' on' : '')}
      data-c={c.name}
      title={props.title || c.name}
      onClick={props.onClick}
      onMouseEnter={() => setState('hot')}
      onMouseLeave={() => setState('idle')}
      onPointerDown={() => setState('down')}
      onPointerUp={() => setState('hot')}
      style={{
        left: c.x1,
        top: c.y1,
        width: w,
        height: h,
        backgroundImage: t ? `url(${t.url})` : undefined,
        backgroundSize: t ? `${f.fw > 1 ? t.w : w}px ${f.fh > 1 ? t.h : h}px` : undefined,
        backgroundPosition: f.fw > 1 ? `${-idx * w}px 0` : f.fh > 1 ? `0 ${-idx * h}px` : '0 0',
        backgroundRepeat: 'no-repeat',
      }}
    />
  )
}

/** 滑杆：轨道 + 填充 + 滑块，横向/纵向由 vertical 决定。 */
function Slider(props: {
  c: TtSkinControl
  assets: Record<string, Tex>
  value: number
  onChange: (v: number) => void
}) {
  const {c, assets, value} = props
  const w = Math.max(1, c.x2 - c.x1)
  const h = Math.max(1, c.y2 - c.y1)
  const vertical = !!c.vertical
  const track = assets[c.barImage || '']?.url
  const fill = assets[c.fillImage || '']?.url
  const thumb = assets[c.thumbImage || '']?.url
  const pct = Math.max(0, Math.min(1, value)) * 100

  const set = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const v = vertical ? 1 - (clientY - r.top) / r.height : (clientX - r.left) / r.width
    props.onChange(Math.max(0, Math.min(1, v)))
  }
  return (
    <div
      className="ttskn-slider"
      style={{left: c.x1, top: c.y1, width: w, height: h, backgroundImage: track ? `url(${track})` : undefined}}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        set(e.clientX, e.clientY, e.currentTarget)
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return
        set(e.clientX, e.clientY, e.currentTarget)
      }}
    >
      {fill && (
        <i
          className="ttskn-fill"
          style={
            vertical
              ? {left: 0, bottom: 0, width: '100%', height: pct + '%', backgroundImage: `url(${fill})`}
              : {left: 0, top: 0, height: '100%', width: pct + '%', backgroundImage: `url(${fill})`}
          }
        />
      )}
      {thumb && (
        <b
          className="ttskn-thumb"
          style={
            vertical
              ? {left: 0, top: `calc(${pct}% - ${h / 2}px)`, width: '100%', height: h,
                 backgroundImage: `url(${thumb})`, backgroundSize: '100% auto'}
              : {top: 0, left: `calc(${pct}% - ${w / 2}px)`, width: w, height: h,
                 backgroundImage: `url(${thumb})`, backgroundSize: 'auto 100%'}
          }
        />
      )}
    </div>
  )
}

/** 竖向推子：均衡器用，10 段共用同一套 eqfactor 贴图。 */
function Fader(props: {
  left: number
  top: number
  width: number
  height: number
  value: number
  fill?: string
  thumb?: string
  title?: string
  onChange?: (v: number) => void
}) {
  const {left, top, width, height, value, fill, thumb} = props
  const pct = Math.max(0, Math.min(1, value)) * 100
  const set = (clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    props.onChange?.(Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height)))
  }
  return (
    <div
      className="ttskn-fader"
      title={props.title}
      style={{left, top, width, height}}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        set(e.clientY, e.currentTarget)
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return
        set(e.clientY, e.currentTarget)
      }}
    >
      {fill && <i style={{backgroundImage: `url(${fill})`, height: pct + '%'}} />}
      {thumb && (
        <b style={{backgroundImage: `url(${thumb})`, top: `calc(${100 - pct}% - ${Math.min(height / 2, 9)}px)`}} />
      )}
    </div>
  )
}

/** 时间：number.bmp 是 12 个并排字形（0-9、:、-），按 1/12 位移取字；量不出来就退回文本。 */
function Led(props: {c: TtSkinControl; assets: Record<string, Tex>; text: string; color: string; bkgnd?: string}) {
  const {c, assets, text} = props
  const w = Math.max(1, c.x2 - c.x1)
  const h = Math.max(1, c.y2 - c.y1)
  const tex = assets[c.image || '']
  const glyphs = 12
  const usable = !!tex && tex.w > 0 && tex.w % glyphs === 0
  if (!usable) {
    return (
      <div
        className="ttskin-led"
        style={{left: c.x1, top: c.y1, width: w, height: h, lineHeight: h + 'px', color: props.color,
                background: props.bkgnd || 'transparent', textAlign: c.align === 'right' ? 'right' : 'left'}}
      >
        {text}
      </div>
    )
  }
  const gw = tex!.w / glyphs
  const scale = h / tex!.h
  const cw = gw * scale
  const maxChars = Math.max(1, Math.floor(w / cw))
  const chars = text.split('').slice(-maxChars)
  const startX = c.align === 'right' ? w - chars.length * cw : 0
  const index = (ch: string) => {
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48
    if (ch === ':') return 10
    if (ch === '-') return 11
    return -1
  }
  return (
    <div
      className="ttskin-led-sprite"
      style={{left: c.x1, top: c.y1, width: w, height: h, background: props.bkgnd || 'transparent'}}
    >
      {chars.map((ch, i) => {
        const gi = index(ch)
        if (gi < 0) return null
        return (
          <span
            key={i}
            style={{
              left: startX + i * cw,
              width: cw,
              height: h,
              backgroundImage: `url(${tex!.url})`,
              backgroundSize: `${tex!.w * scale}px ${tex!.h * scale}px`,
              backgroundPosition: `${-gi * gw * scale}px 0`,
            }}
          />
        )
      })}
    </div>
  )
}

/** 频谱区：接 eq.ts 建好的 AnalyserNode，拿不到（跨源音源）才退回占位动画。 */
function Bars(props: {c: TtSkinControl; playing: boolean; color: string; ensure: () => Promise<Analysts | null>}) {
  const {c, playing, color} = props
  const w = Math.max(1, c.x2 - c.x1)
  const h = Math.max(1, c.y2 - c.y1)
  const cv = useRef<HTMLCanvasElement | null>(null)
  const anRef = useRef<Analysts | null>(null)
  const heights = useRef<number[]>([])
  const ensureRef = useRef(props.ensure)
  ensureRef.current = props.ensure

  // 播放开始时建图，之后一直复用（createMediaElementSource 不可撤销，别反复建）
  useEffect(() => {
    let gone = false
    if (!playing || anRef.current) return
    ensureRef.current().then((a) => {
      if (!gone) anRef.current = a
    })
    return () => {
      gone = true
    }
  }, [playing])

  useEffect(() => {
    let raf = 0
    let frame = 0
    const buf: {data: Uint8Array} = {data: new Uint8Array(1024)}
    const edges = {list: [] as number[], n: 0, bins: 0}
    const n = Math.max(12, Math.min(48, Math.floor(w / 5)))

    const tick = () => {
      raf = requestAnimationFrame(tick)
      frame++
      if (!playing && frame % 6 !== 0) return
      const el = cv.current
      if (!el) return
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
      if (el.width !== w * dpr || el.height !== h * dpr) {
        el.width = w * dpr
        el.height = h * dpr
      }
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const an = anRef.current
      let target: number[]
      if (an && playing) {
        const mixed = an.mixed
        if (buf.data.length !== mixed.frequencyBinCount) buf.data = new Uint8Array(mixed.frequencyBinCount)
        mixed.getByteFrequencyData(buf.data)
        const binHz = mixed.context.sampleRate / 2 / mixed.frequencyBinCount
        if (edges.n !== n || edges.bins !== mixed.frequencyBinCount) {
          edges.list = bucketEdges(mixed.frequencyBinCount, binHz, n)
          edges.n = n
          edges.bins = mixed.frequencyBinCount
        }
        const e = edges.list
        const b = buf.data
        target = Array.from({length: n}, (_, i) => {
          let sum = 0
          let cnt = 0
          for (let k = e[i]; k <= e[i + 1] && k < b.length; k++) {
            sum += b[k]
            cnt++
          }
          if (!cnt) return 0
          // 对数刻度下高频能量本来就低，抬一点看着才平
          const v = (sum / cnt / 255) * (i > n / 2 ? 1.35 : 1)
          return Math.min(1, v)
        })
      } else {
        const t = frame / 7
        target = Array.from({length: n}, (_, i) => {
          if (!playing) return 0.05
          const s = Math.sin((i + 1) * 1.7 + t) * Math.cos(i * 0.9 - t * 0.6)
          return 0.1 + Math.abs(s) * 0.8
        })
      }

      if (heights.current.length !== n) heights.current = new Array(n).fill(0)
      const hs = heights.current
      const bw = w / n
      ctx.fillStyle = color
      for (let i = 0; i < n; i++) {
        // 起得快、落得稍慢，看着才像电平
        hs[i] = Math.max(target[i], hs[i] * 0.86)
        const bh = Math.max(1, Math.floor(hs[i] * (h - 2)))
        ctx.fillRect(Math.floor(i * bw), h - bh, Math.max(1, Math.floor(bw * 0.72)), bh)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [w, h, color, playing])

  return <canvas ref={cv} className="ttskin-vis" style={{left: c.x1, top: c.y1, width: w, height: h}} />
}

/** 子窗口外壳：皮肤里的 lyric_window / playlist_window / equalizer_window 各有自己的底图和按钮。 */
function SubWin(props: {
  win: TtSkinWindow
  assets: Record<string, Tex>
  scale: number
  children: React.ReactNode
  onClose: () => void
  extras?: {c: TtSkinControl; onClick: () => void; title: string; active?: boolean}[]
}) {
  const {win, assets, scale, extras = []} = props
  const bg = win.image ? assets[win.image] : undefined
  const nat = bg && bg.w > 0 ? {w: bg.w, h: bg.h} : {w: Math.max(1, win.w), h: Math.max(1, win.h)}
  const skip = new Set(['close', ...extras.map((x) => x.c.name)])
  return (
    <div className="ttskin-frame" style={{width: nat.w * scale, height: nat.h * scale}}>
      <div className="ttskin-stage" style={{width: nat.w, height: nat.h, transform: `scale(${scale})`}}>
        {bg && <img className="ttskin-bg" src={bg.url} alt="" width={nat.w} height={nat.h} />}
        {props.children}
        {extras.map((x) => (
          <Btn key={x.c.name} c={x.c} assets={assets} onClick={x.onClick} title={x.title} active={x.active} />
        ))}
        {win.controls
          .filter((c) => c.image && ['close', 'ontop', 'desklrc', 'title', 'toolbar'].includes(c.name) && !skip.has(c.name))
          .map((c) =>
            c.name === 'close' ? (
              <Btn key={c.name} c={c} assets={assets} onClick={props.onClose} title="关闭这个窗口" />
            ) : (
              <Btn key={c.name} c={c} assets={assets} title={c.name} />
            ),
          )}
      </div>
    </div>
  )
}

export default function TtSkinView(props: TtSkinViewProps) {
  const {playing, cur, pos, dur, volume, eqGains, preamp, lrc, lrcIndex, queue, qIndex, balance, surround} = props
  const [pack, setPack] = useState<TtSkinPack | null>(null)
  const [file, setFile] = useState(() => localStorage.getItem(LS_SKIN) || '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(true)
  const [assets, setAssets] = useState<Record<string, Tex>>({})
  const [nat, setNat] = useState<{w: number; h: number}>({w: 270, h: 168})
  const [scale, setScale] = useState(1)
  const [subs, setSubs] = useState({lyric: false, playlist: false, equalizer: false})
  const box = useRef<HTMLDivElement | null>(null)
  const plBox = useRef<HTMLDivElement | null>(null)

  // 1. 解包
  useEffect(() => {
    let alive = true
    ;(async () => {
      setBusy(true)
      const p = await getPack()
      if (!alive) return
      if (!p || !p.skins.length) {
        setErr('没找到皮肤插件：去「插件」页装「千千静听皮肤」')
        setBusy(false)
        return
      }
      setPack(p)
      setBusy(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  // 2. 选中的皮肤（没存过就用第一套）
  const skin: TtSkin | null = useMemo(() => {
    if (!pack) return null
    return pack.skins.find((s) => s.file === file) || pack.skins[0]
  }, [pack, file])

  // 3. 抠贴图 + 量主窗口尺寸
  useEffect(() => {
    if (!skin) return
    let alive = true
    ;(async () => {
      const a = await prepareAssets(skin)
      if (!alive) return
      setAssets(a)
      const win = skin.windows.find((w) => w.name === 'player') || skin.windows[0]
      const bg = win?.image ? a[win.image] : undefined
      if (bg && bg.w > 0) setNat({w: bg.w, h: bg.h})
      else if (win) setNat({w: Math.max(1, win.w), h: Math.max(1, win.h)})
    })()
    return () => {
      alive = false
    }
  }, [skin])

  // 4. 按容器宽度等比缩，窗口再大也不溢出
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      const avail = Math.max(120, el.clientWidth - 24)
      setScale(Math.min(1, avail / Math.max(1, nat.w)))
    }
    fit()
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(fit)
      ro.observe(el)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [nat])

  const win = skin?.windows.find((w) => w.name === 'player') || skin?.windows[0]
  const ctrl = (n: string) => win?.controls.find((c) => c.name === n)
  const bgPng = win ? assets[win.image]?.url || '' : ''

  // 播放列表跟着当前曲目滚
  useEffect(() => {
    const el = plBox.current
    if (!el || !subs.playlist) return
    const rowH = 18
    el.scrollTop = Math.max(0, qIndex * rowH - el.clientHeight / 2 + rowH / 2)
  }, [subs.playlist, qIndex, queue.length])

  if (busy) return <div className="ttskin-tip">正在解皮肤包…</div>
  if (err) return <div className="ttskin-tip">{err}</div>
  if (!pack || !skin || !win) return <div className="ttskin-tip">皮肤包里没有可用的窗口</div>

  const info = ctrl('info')
  const status = ctrl('status')
  const led = ctrl('led')
  const visual = ctrl('visual')
  const progress = ctrl('progress')
  const vol = ctrl('volume')
  const play = ctrl('play')
  const tone = status?.color || '#a0a0a0'
  // 频谱颜色跟 stereo 灯走（千千静听默认是绿色）
  const visColor = ctrl('stereo')?.color || '#00c000'

  const lwin = skin.windows.find((w) => w.name === 'lyric' && w.image)
  const pwin = skin.windows.find((w) => w.name === 'playlist' && w.image)
  const ewin = skin.windows.find((w) => w.name === 'equalizer' && w.image)

  const rectOf = (w: TtSkinWindow | undefined, name: string) => {
    const c = w?.controls.find((x) => x.name === name)
    return c && c.x2 > c.x1 && c.y2 > c.y1 ? c : null
  }

  // 歌词：按歌词区的实际高度决定能放几行（Default 只有 21px，就是一行滚动）
  const lrcView = (rect: TtSkinControl | null, fs: number) => {
    const lineH = Math.max(12, fs + 4)
    const rows = Math.max(1, Math.floor(((rect?.y2 || 0) - (rect?.y1 || 0)) / lineH))
    const half = Math.max(0, Math.floor((rows - 1) / 2))
    const out: {i: number; text: string}[] = []
    if (!lrc.length) return out
    const from = Math.max(0, lrcIndex - half)
    const to = Math.min(lrc.length, lrcIndex + (rows - 1 - half) + 1)
    for (let i = from; i < to; i++) out.push({i, text: lrc[i].text})
    return out
  }

  // 均衡器：preamp 一根 + 10 段照 eqfactor 的样子排开（皮肤只给了代表图）
  const eqBase = ewin ? rectOf(ewin, 'eqfactor') : null
  const eqPre = ewin ? rectOf(ewin, 'preamp') : null

  return (
    <div className="ttskin-view" ref={box}>
      <div className="ttskin-toolbar">
        <select
          value={skin.file}
          onChange={(e) => {
            setFile(e.target.value)
            try { localStorage.setItem(LS_SKIN, e.target.value) } catch { /* 忽略 */ }
          }}
          title="换一套 .skn"
        >
          {pack.skins.map((s) => (
            <option key={s.file} value={s.file}>{s.name || s.file}</option>
          ))}
        </select>
        <span className="ttskin-by">{skin.author || '未知作者'}</span>
        <button className="ghost-btn" onClick={props.onExit}>退出 TT 模式</button>
      </div>

      <div className="ttskin-frame" style={{width: nat.w * scale, height: nat.h * scale}}>
        <div className="ttskin-stage" style={{width: nat.w, height: nat.h, transform: `scale(${scale})`}}>
          {bgPng && <img className="ttskin-bg" src={bgPng} alt="" width={nat.w} height={nat.h} />}

          {/* 曲名 / 艺术家：千千静听的信息区是一条带底色的字条 */}
          {info && (
            <div
              className="ttskin-text"
              style={{
                left: info.x1, top: info.y1,
                width: info.x2 - info.x1, height: info.y2 - info.y1,
                color: info.color || '#fff',
                background: info.bkgnd || 'transparent',
                fontFamily: info.font ? `"${info.font}", "SimSun", sans-serif` : '"SimSun", sans-serif',
                fontSize: (info.fontSize || 12) + 'px',
                lineHeight: (info.y2 - info.y1) + 'px',
                textAlign: info.align === 'right' ? 'right' : info.align === 'center' ? 'center' : 'left',
              }}
            >
              {cur ? (cur.name || '未命名') + (cur.artist ? ' - ' + cur.artist : '') : '千千静听'}
            </div>
          )}

          {led && <Led c={led} assets={assets} text={fmtT(pos)} color={tone} bkgnd={status?.bkgnd} />}

          {status && (
            <div
              className="ttskin-text small"
              style={{
                left: status.x1, top: status.y1,
                width: status.x2 - status.x1, height: status.y2 - status.y1,
                color: tone,
                background: status.bkgnd || 'transparent',
                fontFamily: status.font ? `"${status.font}", "SimSun", sans-serif` : '"SimSun", sans-serif',
                fontSize: (status.fontSize || 11) + 'px',
                lineHeight: (status.y2 - status.y1) + 'px',
                textAlign: status.align === 'right' ? 'right' : 'left',
              }}
            >
              {playing ? '状态: 播放' : '状态: 暂停'}{props.eqOn ? ' · EQ' : ''}
            </div>
          )}

          {visual && <Bars c={visual} playing={playing} color={visColor} ensure={props.ensure} />}

          {/* 进度 / 音量：点轨道任意位置直接跳 */}
          {progress && (
            <Slider c={progress} assets={assets} value={dur > 0 ? pos / dur : 0} onChange={(v) => props.onSeek(v)} />
          )}
          {vol && <Slider c={vol} assets={assets} value={volume} onChange={props.onVolume} />}

          {/* 按钮：play 在播放时换成 pause 的贴图（千千静听的老规矩） */}
          {play && (
            <Btn c={play} assets={assets} swap={playing ? 'pause' : undefined} onClick={props.onToggle}
                 title={playing ? '暂停' : '播放'} />
          )}
          {ctrl('stop') && <Btn c={ctrl('stop')!} assets={assets} onClick={props.onStop} title="停止" />}
          {ctrl('prev') && <Btn c={ctrl('prev')!} assets={assets} onClick={props.onPrev} title="上一首" />}
          {ctrl('next') && <Btn c={ctrl('next')!} assets={assets} onClick={props.onNext} title="下一首" />}
          {ctrl('mute') && <Btn c={ctrl('mute')!} assets={assets} onClick={props.onMute} title="静音" />}

          {/* ── 子窗口开关（open / browser / lyric / equalizer / playlist）── */}
          {ctrl('open') && <Btn c={ctrl('open')!} assets={assets} onClick={props.onOpen} title="打开文件夹（加歌）" />}
          {ctrl('browser') && <Btn c={ctrl('browser')!} assets={assets} onClick={props.onMusicWindow} title="音乐窗" />}
          {ctrl('lyric') && (
            <Btn c={ctrl('lyric')!} assets={assets} onClick={() => setSubs((s) => ({...s, lyric: !s.lyric}))}
                 title="歌词秀" active={subs.lyric} />
          )}
          {ctrl('equalizer') && (
            <Btn c={ctrl('equalizer')!} assets={assets} onClick={() => setSubs((s) => ({...s, equalizer: !s.equalizer}))}
                 title="均衡器" active={subs.equalizer} />
          )}
          {ctrl('playlist') && (
            <Btn c={ctrl('playlist')!} assets={assets} onClick={() => setSubs((s) => ({...s, playlist: !s.playlist}))}
                 title="播放列表" active={subs.playlist} />
          )}

          {ctrl('minimize') && <Btn c={ctrl('minimize')!} assets={assets} onClick={props.onMini} title="小窗口" />}
          {ctrl('minimode') && <Btn c={ctrl('minimode')!} assets={assets} onClick={props.onMini} title="迷你模式" />}
          {ctrl('exit') && <Btn c={ctrl('exit')!} assets={assets} onClick={props.onExit} title="退出 TT 模式" />}

          {/* 剩下的（ontop、set、mode_* 之类）原样画出来，先不接功能 */}
          {win.controls
            .filter(
              (c) =>
                c.image &&
                !['play', 'pause', 'stop', 'prev', 'next', 'mute', 'minimize', 'minimode', 'exit', 'open',
                  'browser', 'lyric', 'equalizer', 'playlist'].includes(c.name) &&
                !['progress', 'volume', 'info', 'led', 'status', 'visual', 'stereo', 'icon', 'set'].includes(c.name) &&
                !/^mode_/.test(c.name),
            )
            .map((c) => <Btn key={c.name} c={c} assets={assets} title={c.name} />)}
        </div>
      </div>

      {/* ── 歌词窗 ── */}
      {lwin && subs.lyric && (() => {
        const r = rectOf(lwin, 'lyric')
        const fs = Math.max(11, r?.fontSize || 13)
        const lines = r ? lrcView(r, fs) : []
        const extras = lwin.controls
          .filter((c) => c.name === 'ontop' || c.name === 'desklrc')
          .map((c) =>
            c.name === 'ontop'
              ? {c, onClick: props.onOntop, title: props.ontop ? '取消置顶' : '窗口置顶', active: props.ontop}
              : {c, onClick: props.onDeskLrc, title: props.deskLrc ? '关闭桌面歌词' : '桌面歌词（独立小窗口）', active: props.deskLrc},
          )
        return (
          <SubWin win={lwin} assets={assets} scale={scale} onClose={() => setSubs((s) => ({...s, lyric: false}))} extras={extras}>
            {r && (
              <div
                className="ttskin-lyric"
                style={{left: r.x1, top: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1,
                        fontFamily: r.font ? `"${r.font}", "SimSun", sans-serif` : '"SimSun", sans-serif',
                        fontSize: fs + 'px', lineHeight: fs + 4 + 'px'}}
              >
                {lines.length ? lines.map((l) => (
                  <div key={l.i} className={l.i === lrcIndex ? 'on' : ''}>{l.text || '…'}</div>
                )) : <div className="dim">没有歌词</div>}
              </div>
            )}
          </SubWin>
        )
      })()}

      {/* ── 播放列表窗 ── */}
      {pwin && subs.playlist && (() => {
        const r = rectOf(pwin, 'playlist')
        if (!r) return null
        return (
          <SubWin win={pwin} assets={assets} scale={scale} onClose={() => setSubs((s) => ({...s, playlist: false}))}>
            <div
              className="ttskin-pl"
              ref={plBox}
              style={{left: r.x1, top: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1}}
            >
              {queue.length ? queue.map((t, i) => (
                <div
                  key={t.id + i}
                  className={'ttskin-pl-row' + (i === qIndex ? ' on' : '')}
                  onClick={() => props.onPick(i)}
                  title={t.name + (t.artist ? ' - ' + t.artist : '')}
                >
                  <span className="n">{i + 1}</span>
                  <span className="t">{t.name}</span>
                  <span className="a">{t.artist || ''}</span>
                </div>
              )) : <div className="ttskin-pl-empty">待播清单是空的</div>}
            </div>
          </SubWin>
        )
      })()}

      {/* ── 均衡器窗 ── */}
      {ewin && subs.equalizer && (
        <SubWin
          win={ewin}
          assets={assets}
          scale={scale}
          onClose={() => setSubs((s) => ({...s, equalizer: false}))}
          extras={[
            ...ewin.controls.filter((c) => c.name === 'enabled').map((c) => ({
              c, onClick: props.onEqToggle, title: props.eqOn ? '关闭均衡器' : '打开均衡器', active: props.eqOn,
            })),
            ...ewin.controls.filter((c) => c.name === 'reset').map((c) => ({
              c, onClick: props.onEqReset, title: '全部归零',
            })),
          ]}
        >
          {(() => {
            const bal = rectOf(ewin, 'balance')
            const sur = rectOf(ewin, 'surround')
            return (
              <>
                {bal && (
                  <Slider
                    c={bal} assets={assets}
                    value={(balance + 1) / 2}
                    onChange={(v) => props.onBalance(v * 2 - 1)}
                  />
                )}
                {sur && (
                  <Slider c={sur} assets={assets} value={surround} onChange={(v) => props.onSurround(v)} />
                )}
              </>
            )
          })()}
          {eqPre && (
            <Fader
              left={eqPre.x1} top={eqPre.y1}
              width={Math.max(6, eqPre.x2 - eqPre.x1)} height={eqPre.y2 - eqPre.y1}
              value={Math.max(0, Math.min(1, (preamp - 0.2) / 1.8))}
              fill={assets[eqPre.fillImage || '']?.url}
              thumb={assets[eqPre.thumbImage || '']?.url}
              title={'前置放大 ' + preamp.toFixed(2)}
              onChange={(v) => props.onPreamp(0.2 + v * 1.8)}
            />
          )}
          {eqBase && (() => {
            const n = 10
            const winW = (ewin.image && assets[ewin.image]?.w) || ewin.w
            const x0 = eqBase.x1
            const x1 = Math.max(x0 + 40, winW - 16)
            const step = (x1 - x0) / (n - 1)
            const bw = Math.max(6, eqBase.x2 - eqBase.x1)
            const fill = assets[eqBase.fillImage || '']?.url
            const thumb = assets[eqBase.thumbImage || '']?.url
            const hz = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
            return Array.from({length: n}, (_, i) => {
              const g = eqGains[i] || 0
              return (
                <Fader
                  key={i}
                  left={Math.round(x0 + step * i)} top={eqBase.y1} width={bw} height={eqBase.y2 - eqBase.y1}
                  value={(g + 12) / 24}
                  fill={fill} thumb={thumb}
                  title={hz[i] + 'Hz  ' + (g > 0 ? '+' : '') + g + 'dB'}
                  onChange={(v) => props.onEqGain(i, Math.round(v * 24 - 12))}
                />
              )
            })
          })()}
        </SubWin>
      )}
    </div>
  )
}
