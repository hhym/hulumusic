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
  inLib: boolean
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onSeek: (ms: number) => void
  onVolume: (v: number) => void
  onFav: () => void
  onPlayAt: (i: number) => void
  onExpand: () => void
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
export default function SkinView(p: Props) {
  const [skinName, setSkinName] = useState(loadSkin)
  const selectSkin = (id: string) => {
    setSkinName(id)
    try { localStorage.setItem(SKIN_KEY, id) } catch { /* 忽略 */ }
  }

  // Esc 还原桌面窗口；空格播放暂停。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onExpand()
      if (e.key === ' ') { e.preventDefault(); p.onToggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  // 无边框窗口：标题栏拖动换算成位移送 Go，和迷你卡同一套做法。
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

  return (
    <div className="skin-view" data-skin={skinName}>
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

      {/* 主播放面板 */}
      <section className="skin-panel skin-player">
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
        </div>
      </section>

      {/* 均衡器面板 */}
      <section className="skin-panel skin-eq">
        <div className="skin-panel-head">
          <span>均衡器</span>
          <span className="skin-eq-bars">
            {(p.eqGains.length ? p.eqGains : Array(10).fill(0)).map((g, i) => (
              <span key={i} className="skin-eq-fader" style={{'--gain': g} as any}>
                <i />
              </span>
            ))}
          </span>
        </div>
      </section>

      {/* 歌词秀面板 */}
      <section className="skin-panel skin-lyric">
        <div className="skin-panel-head"><span>歌词秀</span></div>
        <div className="skin-lyric-box">
          <div className="skin-lyric-prev">{prevLine || ' '}</div>
          <div className="skin-lyric-cur">{curLine || title}</div>
          <div className="skin-lyric-next">{nextLine || ' '}</div>
        </div>
      </section>

      {/* 播放列表面板 */}
      <section className="skin-panel skin-playlist">
        <div className="skin-panel-head"><span>播放列表</span><span className="skin-pl-count">{p.queue.list.length} 首</span></div>
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
      </section>
    </div>
  )
}
