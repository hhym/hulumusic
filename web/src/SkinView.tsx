import {useEffect, useRef, useState} from 'react'
import {Fi, FN} from './feather'

type Track = {id: string; name: string; artist: string; album: string; cover: string; duration: number; source: string; plug?: string}
type LyricLine = {time: number; text: string}

type Props = {
  cur: Track | null
  playing: boolean
  busy: boolean
  pos: number
  dur: number
  lyric: LyricLine[]
  curIndex: number
  queue: {list: Track[]; idx: number}
  volume: number
  eqGains: number[]
  eqOn: boolean
  eqPreset: number
  eqPresets: string[]
  shuffle: boolean
  inLib: boolean
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onSeek: (ms: number) => void
  onVolume: (v: number) => void
  onFav: () => void
  onPlayAt: (i: number) => void
  onEqToggle: () => void
  onEqReset: () => void
  onEqPreset: (i: number) => void
  onShuffle: () => void
  onRemoveAt: (i: number) => void
  onClearList: () => void
  onClearNext: () => void
  onExpand: () => void
  /** 经典四窗：只画某一块面板（副窗用）；不传就是主窗 */
  only?: 'main' | 'eq' | 'lyric' | 'playlist'
  /** 主窗推过来的配色。副窗每块都是独立的 WebView，localStorage 不共享，
      所以配色不能靠各自读本地存储，必须由主窗推送。 */
  skinName?: string
  onSkinPick?: (id: string) => void
}

const fmt = (ms: number) => {
  if (!isFinite(ms) || ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// 可选皮肤配色：id 对应 style.css 里的 .skin-view[data-skin=...] 变量组。
const SKINS = [
  {id: 'purple', label: '深紫', color: '#b79bff'},
  {id: 'blue', label: '经典蓝', color: '#7fd4ff'},
  {id: 'pink', label: '粉红', color: '#ff9ec4'},
  {id: 'orange', label: '烧歌橙', color: '#ffb066'},
  {id: 'neon', label: '霓虹紫', color: '#d26bff'},
  {id: 'cyan', label: '青碧', color: '#66e0d0'},
  {id: 'grey', label: '青灰', color: '#7fd0c0'},
  {id: 'light', label: '浅蓝', color: '#3a86c9'},
]
const SKIN_KEY = 'hulu-skin'
const ZOOM_KEY = 'hulu-skin-lyric-zoom'
const zoomClamp = (z: number) => Math.min(300, Math.max(80, Math.round(z / 10) * 10))
// 歌词字号缩放，跟桌面版歌词秀窗口那排「220% ＋ －」一个意思：80%–300%，10% 一档。
function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY))
    if (isFinite(v) && v > 0) return zoomClamp(v)
  } catch { /* 忽略 */ }
  return 100
}
function loadSkin(): string {
  try {
    const v = localStorage.getItem(SKIN_KEY)
    if (SKINS.some((s) => s.id === v)) return v!
  } catch { /* 忽略 */ }
  return 'purple'
}

/* 竖向皮肤界面：窗口固定 480×1024，按经典千千静听四面板纵向堆叠——
   主播放面板（LCD + 走带 + 音量）、均衡器面板、歌词秀面板、播放列表面板。
   配色是皮肤自己的一套深紫变量，不跟主界面主题走；后续多套皮肤在这里换皮。 */
// 拖动：Windows 上交给 Go 端原生拖动（DragWindow 里轮询光标 + SetWindowPos）。
// 宿主 mygo 的 --app-region:drag 在 Windows 上走的是系统模态拖动循环，在
// 这种无边框透明 + 运行时改过尺寸的窗口上不稳，皮肤标题栏已不再设 drag 区。
const HAS_GO_APP = typeof (window as any).go?.main?.App !== 'undefined'

export default function SkinView(p: Props) {
  const [skinName, setSkinName] = useState(() => p.skinName || loadSkin())
  const [zoom, setZoom] = useState(loadZoom)
  // 主窗换了配色会推过来；副窗只是被动跟随，自己不出色板。
  useEffect(() => {
    if (p.skinName && p.skinName !== skinName) setSkinName(p.skinName)
  }, [p.skinName])
  const selectSkin = (id: string) => {
    setSkinName(id)
    try { localStorage.setItem(SKIN_KEY, id) } catch { /* 忽略 */ }
    p.onSkinPick?.(id)
  }
  const selectZoom = (z: number) => {
    const v = zoomClamp(z)
    setZoom(v)
    try { localStorage.setItem(ZOOM_KEY, String(v)) } catch { /* 忽略 */ }
  }
  // 连点「＋/－」时用函数式更新，避免每次拿到的都是同一份旧 state。
  const nudgeZoom = (d: number) => setZoom((prev) => {
    const v = zoomClamp(prev + d)
    try { localStorage.setItem(ZOOM_KEY, String(v)) } catch { /* 忽略 */ }
    return v
  })

  // 皮肤窗整页铺皮肤底色：页面外圈和窗口右上那圈不再露出主界面的深色。
  useEffect(() => {
    document.body.classList.add('skin-body')
    return () => {
      document.body.classList.remove('skin-body')
      document.body.style.background = ''
    }
  }, [])
  useEffect(() => {
    const el = document.querySelector('.skin-view') as HTMLElement | null
    const bg = el ? getComputedStyle(el).getPropertyValue('--bg1').trim() : ''
    document.body.style.background = bg || '#160d29'
  }, [skinName])

  // Esc 还原桌面窗口；空格播放暂停。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onExpand()
      if (e.key === ' ') { e.preventDefault(); p.onToggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  // 标题栏按下 → Go 端原生拖动（自己轮询光标，松开左键自动结束）。
  // 纯浏览器预览没有 go 桥时，退回到前端算位移的兜底。
  const drag = useRef({dx: 0, dy: 0, raf: 0})
  const flushMove = () => {
    const st = drag.current
    st.raf = 0
    if (!st.dx && !st.dy) return
    const dpr = window.devicePixelRatio || 1
    const dx = Math.round(st.dx * dpr)
    const dy = Math.round(st.dy * dpr)
    st.dx = 0
    st.dy = 0
    const app = (window as any).go?.main?.App
    try { app?.WinMoveBy?.(dx, dy) } catch { /* 老版本没这个方法，忽略 */ }
  }
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button,input')) return
    e.preventDefault()
    const app = (window as any).go?.main?.App
    if (HAS_GO_APP && app?.DragWindow) {
      try { app.DragWindow(p.only || 'main') } catch { /* 忽略 */ }
      return
    }
    const onMove = (ev: MouseEvent) => {
      drag.current.dx += ev.movementX
      drag.current.dy += ev.movementY
      if (!drag.current.raf) drag.current.raf = requestAnimationFrame(flushMove)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (drag.current.raf) { cancelAnimationFrame(drag.current.raf); drag.current.raf = 0; flushMove() }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const title = p.cur ? `${p.cur.name} — ${p.cur.artist || '未知歌手'}` : '未在播放'
  const curLine = p.curIndex >= 0 && p.lyric[p.curIndex] ? p.lyric[p.curIndex].text : ''
  const prevLine = p.curIndex > 0 ? p.lyric[p.curIndex - 1].text : ''
  const nextLine = p.curIndex >= 0 && p.lyric[p.curIndex + 1] ? p.lyric[p.curIndex + 1].text : ''

  // 经典四窗那套：每个面板自带一条小标题栏，□ 折叠、× 收起。
  const [open, setOpen] = useState({eq: true, lyric: true, pl: true})
  const flip = (k: 'eq' | 'lyric' | 'pl') => setOpen((o) => ({...o, [k]: !o[k]}))
  const sev = Object.values(open)
  const allOpen = sev.every(Boolean)

  // 经典四窗：副窗里只画自己那一块，□ 卷起成一条标题栏、× 收起窗口。
  const solo = p.only && p.only !== 'main' ? p.only : ''
  const isMain = !solo
  const bridge = (window as any).go?.main?.App
  const winHide = (n: string) => { try { bridge?.HidePanel?.(n) } catch { /* 忽略 */ } }
  const winShow = (n: string) => { try { bridge?.ShowPanel?.(n) } catch { /* 忽略 */ } }
  const [rolled, setRolled] = useState(false)
  const roll = () => {
    const h = rolled ? ({eq: 126, lyric: 216} as any)[solo] || window.innerHeight : 26
    try { bridge?.RollPanel?.(solo, h) } catch { /* 忽略 */ }
    setRolled((v) => !v)
  }
  // 只要传了 only，就只画那一个面板（四窗各自独立，主窗也不再重复画另外三块）；
  // 浏览器预览不带 only，才把四块都画出来。
  const showEq = p.only ? p.only === 'eq' : open.eq
  const showLyric = p.only ? p.only === 'lyric' : open.lyric
  const showPl = p.only ? p.only === 'playlist' : open.pl

  const bar = (k?: 'eq' | 'lyric' | 'pl', icon = 'music', name = '', extra?: React.ReactNode) => (
    <div className="skin-win-bar" onMouseDown={onMouseDown}>
      <span className="skin-win-ico"><Fi n={icon} size={9} /></span>
      <span className="skin-win-t">{name}</span>
      {extra}
      <button className="skin-win-btn" title={k ? '折叠 / 展开' : '全部面板折叠 / 展开'}
              onClick={() => (solo ? roll() : k ? flip(k) : setOpen({eq: !allOpen, lyric: !allOpen, pl: !allOpen}))}>
        <Fi n="square" size={8} />
      </button>
      <button className="skin-win-btn close" title={k ? '收起该面板' : '切回桌面'}
              onClick={() => (solo ? winHide(solo) : k ? setOpen((o) => ({...o, [k]: false})) : p.onExpand())}>
        <Fi n="x" size={8} />
      </button>
    </div>
  )

  const presets = p.eqPresets.length ? p.eqPresets : ['默认']
  const presetName = presets[p.eqPreset] || presets[0]

  return (
    <div className={'skin-view' + (solo ? ' skin-solo' : '')} data-skin={skinName}>
      {isMain && (<>
      {/* 标题栏 */}
      <div className="skin-title" onMouseDown={onMouseDown}>
        <span className="skin-title-ico">♪</span>
        <span className="skin-title-name">千千静听</span>
        <span className="skin-title-tools">
          <button className="skin-title-btn" onClick={p.onExpand} title="切换回桌面">
            <Fi n="shirt" size={12} />
          </button>
          <button className="skin-title-btn" onClick={p.onFav} disabled={!p.cur}
                  title={p.inLib ? '取消收藏' : '收藏'}>
            <Fi n="heart" fill size={12} />
          </button>
        </span>
      </div>

      <div className="skin-swatches">
        {SKINS.map((s) => (
          <button key={s.id} className={'skin-swatch' + (s.id === skinName ? ' on' : '')}
                  style={{background: s.color}} title={s.label} onClick={() => selectSkin(s.id)} />
        ))}
        <span className="skin-swatch-lab">{SKINS.find((s) => s.id === skinName)?.label}</span>
      </div>
      </>)}

      {isMain && (<>
      {/* 主播放面板（对应经典主窗） */}
      <section className="skin-panel skin-player skin-win">
        {bar(undefined, 'music', '千千静听', (
          <span className="skin-win-tools">
            <button className={'skin-mini-btn' + (open.pl ? ' on' : '')} title="播放列表"
                    onClick={() => { if (open.pl) winHide('playlist'); else winShow('playlist'); flip('pl') }}>PL</button>
            <button className={'skin-mini-btn' + (open.eq ? ' on' : '')} title="均衡器"
                    onClick={() => { if (open.eq) winHide('eq'); else winShow('eq'); flip('eq') }}>EQ</button>
            <button className={'skin-mini-btn' + (open.lyric ? ' on' : '')} title="歌词秀"
                    onClick={() => { if (open.lyric) winHide('lyric'); else winShow('lyric'); flip('lyric') }}>LRC</button>
          </span>
        ))}
        <div className="skin-win-body">
          <div className="skin-lcd">
            <div className="skin-lcd-left">
              <div className="skin-lcd-album">{p.cur?.album || (p.cur ? p.cur.name : '专辑：—')}</div>
              <div className="skin-lcd-meta">
                <span>立体声</span>
                <span>状态：{p.busy ? '取流中' : p.playing ? '播放' : '暂停'}</span>
              </div>
            </div>
            <div className="skin-lcd-right">
              <div className="skin-lcd-time">{fmt(p.pos)}</div>
              <div className="skin-lcd-dur">/ {fmt(p.dur)}</div>
            </div>
          </div>

          <div className="skin-progress">
            <input type="range" min={0} max={p.dur || 0} step={100} value={Math.min(p.pos, p.dur || 0)}
                   onChange={(e) => p.onSeek(Number(e.target.value))} />
          </div>

          <div className="skin-transport">
            <button onClick={p.onPrev} title="上一首"><Fi n="skip-back" fill size={18} /></button>
            <button className="skin-play" onClick={p.onToggle} disabled={!p.cur}
                    title={p.busy ? '取流中' : p.playing ? '暂停' : '播放'}>
              <Fi n={FN(p.playing ? 'pause' : 'play')} fill size={20} />
            </button>
            <button onClick={p.onNext} title="下一首"><Fi n="skip-forward" fill size={18} /></button>
            <div className="skin-volume">
              <Fi n={p.volume > 0 ? 'volume-high' : 'volume-mute'} size={14} />
              <input type="range" min={0} max={1} step={0.01} value={p.volume}
                     onChange={(e) => p.onVolume(Number(e.target.value))} />
            </div>
            <button className="skin-desk-btn" onClick={p.onExpand} title="回到桌面主界面">音乐窗</button>
          </div>
        </div>
      </section>
      </>)}

      {/* 均衡器面板 */}
      {showEq && (
        <section className="skin-panel skin-eq skin-win">
          {bar('eq', 'sliders', '均衡器', (
            <span className="skin-eq-ctl">
              <button className={'skin-mini-btn' + (p.eqOn ? ' on' : '')} onClick={p.onEqToggle}
                      title={p.eqOn ? '关闭均衡器' : '开启均衡器'}>{p.eqOn ? 'ON' : 'OFF'}</button>
              <button onClick={p.onEqReset} title="全部推子归零">RESET</button>
              <button onClick={() => p.onEqPreset((p.eqPreset + 1) % presets.length)}
                      title={`当前：${presetName}`}>PRESETS</button>
            </span>
          ))}
          <div className="skin-win-body skin-eq-body">
            <div className="skin-eq-scale">
              <span>+12dB</span>
              <span>0dB</span>
              <span>-12dB</span>
            </div>
            <span className="skin-eq-bars">
              {(p.eqGains.length ? p.eqGains : Array(10).fill(0)).map((g, i) => (
                <span key={i} className="skin-eq-fader" style={{'--gain': g} as any}>
                  <i />
                </span>
              ))}
            </span>
          </div>
        </section>
      )}

      {/* 歌词秀面板 */}
      {showLyric && (
        <section className="skin-panel skin-lyric skin-win">
          {bar('lyric', 'document-text', '歌词秀', (
            <span className="skin-lyric-zoom">
              <button onClick={() => nudgeZoom(-10)} disabled={zoom <= 80} title="歌词缩小">
                <Fi n="minus" size={10} />
              </button>
              <button className="skin-zoom-val" onClick={() => selectZoom(100)} title="点一下回到 100%">
                {zoom}%
              </button>
              <button onClick={() => nudgeZoom(10)} disabled={zoom >= 300} title="歌词放大">
                <Fi n="plus" size={10} />
              </button>
            </span>
          ))}
          <div className="skin-win-body">
            <div className="skin-lyric-box" style={{'--lz': zoom / 100} as any}>
              <div className="skin-lyric-prev">{prevLine || ' '}</div>
              <div className="skin-lyric-cur">{curLine || title}</div>
              <div className="skin-lyric-next">{nextLine || ' '}</div>
            </div>
          </div>
        </section>
      )}

      {/* 播放列表面板 */}
      {showPl && (
        <section className="skin-panel skin-playlist skin-win">
          {bar('pl', 'list', '播放列表', <span className="skin-pl-count">{p.queue.list.length} 首</span>)}
          <div className="skin-win-body skin-pl-body">
            <div className="skin-pl-tools">
              <button onClick={() => p.onRemoveAt(p.queue.idx)} disabled={!p.queue.list.length}
                      title="从列表里删掉当前这首"><Fi n="trash-2" size={11} /></button>
              <button onClick={p.onClearNext} disabled={!p.queue.list.length} title="清空待播（保留当前）">
                <Fi n="rotate-ccw" size={11} />
              </button>
              <button onClick={p.onClearList} disabled={!p.queue.list.length} title="清空整个列表">
                <Fi n="x" size={11} />
              </button>
              <button className={p.shuffle ? 'on' : ''} onClick={p.onShuffle}
                      title={p.shuffle ? '随机播放：开' : '随机播放：关'}>
                <Fi n="shuffle" size={11} />
              </button>
              <span className="skin-pl-tab">[默认]</span>
            </div>
            <div className="skin-pl-list">
              {p.queue.list.length === 0 && <div className="skin-pl-empty">列表为空，去搜索加歌</div>}
              {p.queue.list.map((t, i) => (
                <div key={t.id + i} className={'skin-pl-row' + (i === p.queue.idx ? ' on' : '')}
                     onClick={() => p.onPlayAt(i)}>
                  <span className="skin-pl-idx">{i + 1}</span>
                  <span className="skin-pl-name">{t.name}</span>
                  <span className="skin-pl-artist">{t.artist || '未知'}</span>
                  <span className="skin-pl-dur">{fmt((t.duration || 0) * 1000)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
