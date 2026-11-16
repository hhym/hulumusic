import {useEffect, useRef, useState} from 'react'
import {THEME_ICON, THEME_LABEL, type Theme} from './theme'
import {Fi, FN} from './feather'

type Track = {id: string; name: string; artist: string; album: string; cover: string; duration: number; source: string; plug?: string}

type Props = {
  cur: Track | null
  lyricText?: string   // 当前这句歌词；没歌词时退回歌名
  playing: boolean
  busy: boolean
  isLive: boolean
  inLib: boolean
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onExpand: () => void   // Esc：还原成桌面窗口
  onDesk: () => void     // 小窗图标：切到桌面界面
  onSkin: () => void     // 大窗图标：切到皮肤界面
  onClose: () => void    // ×：直接退出播放器
  onFav: () => void
  onQueue: () => void
  theme: Theme         // 当前主题（迷你卡直接吃主界面的那套配色变量）
  onTheme: () => void  // 点主题图标：切到下一档
}

/* 迷你播放器：窗口缩成一个浮在桌面上的小卡片。
   形态按用户给的截图：左边一枚压在卡片上的圆形封面，
   右边一排图标（收藏／上一首／播放／下一首／列表），
   最右一列竖排四个按钮：主题／小窗（回桌面界面）／大窗（进皮肤界面）／×（退出播放器）。
   卡片配色全部走主题变量，所以橘黄、冷白、深色下都跟主界面一致。
   快捷键：Esc 还原，空格播放暂停。 */
export default function MiniPlayer(p: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onExpand()
      if (e.key === ' ') { e.preventDefault(); p.onToggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  const title = p.cur ? `${p.cur.name} — ${p.cur.artist || '未知歌手'}` : '未在播放'

  // 卡片只有 188px 宽，一行中文歌词基本都放不下，所以量一下溢出多少，
  // 用 CSS 变量把位移和时长塞进 keyframes，做一条来回复读的小跑马灯。
  const lyricRef = useRef<HTMLDivElement | null>(null)
  const [shift, setShift] = useState(0)
  useEffect(() => {
    const el = lyricRef.current
    if (!el) return
    const over = el.scrollWidth - el.clientWidth
    setShift(over > 4 ? over : 0)
  }, [p.lyricText])

  // 无边框窗口没有系统标题栏可拖，这里手动把鼠标位移换算成窗口位移送进 Go
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
    const t = e.target as HTMLElement
    if (t.closest('button')) return
    // 千千静听窗口（mygo-music 里加装的）由 mygo 按 CSS --app-region: drag 自己拖，
    // 这里再 preventDefault 会把它的拖动打断。
    if (document.body.classList.contains('qq-owned')) return
    e.preventDefault()
    // 注意：这里不能用 Win32 的窗口拖动循环（SendMessage WM_NCLBUTTONDOWN + HTCAPTION）。
    // 在无边框 + 区域裁剪的小窗口上，那条路径会让进程直接退出，表现就是「进迷你点一下就闪退」。
    // 改成前端自己算鼠标位移、逐帧调 WinMoveBy，只走 Wails 的 WindowSetPosition，稳定得多。
    const onMove = (ev: MouseEvent) => {
      drag.current.dx += ev.movementX
      drag.current.dy += ev.movementY
      if (!drag.current.raf) drag.current.raf = requestAnimationFrame(flushMove)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (drag.current.raf) {
        cancelAnimationFrame(drag.current.raf)
        drag.current.raf = 0
        flushMove()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="mini-player">
      <div className="mini-card" title={title} onMouseDown={onMouseDown}>
        <div className={'mini-cover' + (p.cur?.cover ? '' : ' empty')}
             style={p.cur?.cover ? {backgroundImage: `url("${p.cur.cover}")`} : undefined}>
          {!p.cur?.cover && <span className="mini-cover-ph">♪</span>}
        </div>

        <div
          ref={lyricRef}
          key={p.lyricText || 'idle'}
          className={'mini-lyric' + (shift ? ' scroll' : '')}
          style={shift ? ({'--shift': `-${shift}px`, '--dur': `${Math.max(3, shift / 18)}s`} as any) : undefined}
          title={p.lyricText || ''}
        >
          {p.lyricText || (p.cur ? `${p.cur.name} — ${p.cur.artist || '未知歌手'}` : '未在播放')}
        </div>

        <div className="mini-ops">
          <button className={'mini-fav' + (p.inLib ? ' on' : '')} onClick={p.onFav}
                  disabled={!p.cur} title={p.inLib ? '取消收藏' : '收藏'}>
            <Fi n="heart" fill size={21} />
          </button>

          <button onClick={p.onPrev} title="上一首">
            <Fi n="skip-back" fill size={19} />
          </button>

          <button className="mini-play" onClick={p.onToggle} disabled={!p.cur}
                  title={p.busy ? '取流中' : p.playing ? '暂停' : '播放'}>
            <Fi n={FN(p.playing ? 'pause' : 'play')} fill size={18} />
          </button>

          <button onClick={p.onNext} title="下一首">
            <Fi n="skip-forward" fill size={19} />
          </button>

          <button onClick={p.onQueue} title="待播清单">
            <Fi n="list" fill size={20} />
          </button>
        </div>

        <div className="mini-tools">
          <button className="mini-theme" onClick={p.onTheme} title={'主题：' + THEME_LABEL[p.theme] + '（点一下换下一档）'}>
            <span className="mini-theme-ico">{THEME_ICON[p.theme]}</span>
          </button>
          <button className="mini-desk" onClick={p.onDesk} title="切到桌面界面">
            <Fi n="layout" size={13} />
          </button>
          <button className="mini-skin" onClick={p.onSkin} title="切到皮肤界面">
            <Fi n="layers" size={13} />
          </button>
          <button className="mini-close" onClick={p.onClose} title="关闭播放器">
            <Fi n="x" size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
