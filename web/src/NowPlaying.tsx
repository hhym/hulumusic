import {useMemo} from 'react'

type Track = {id: string; name: string; artist: string; album: string; cover: string; duration: number; source: string; plug?: string}
type LyricLine = {time: number; text: string}

const fmt = (ms: number) => {
  if (!ms || !isFinite(ms) || ms < 0) return '0:00'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const COVER_GRAD = 'linear-gradient(174deg,#3a4fc4 0%,#4a4ccb 20%,#6a57c1 46%,#a269ae 72%,#ef7d9d 100%)'

type Props = {
  cur: Track | null
  playing: boolean
  pos: number
  dur: number
  lyric: LyricLine[]
  curIndex: number
  busy: boolean
  isLive: boolean
  volume: number
  inLib: boolean
  shuffle: boolean
  repeat: boolean
  errText: string
  onClose: () => void
  onToggle: () => void
  onSeek: (ms: number) => void
  onVolume: (v: number) => void
  onFav: () => void
  onPrev: () => void
  onNext: () => void
  onShuffle: () => void
  onRepeat: () => void
  queue: Track[]
  queueIdx: number
  onPlayAt: (i: number) => void
  onRemove: (i: number) => void
}

export default function NowPlaying(p: Props) {
  const LINE = 54
  const lines = Array.isArray(p.lyric) ? p.lyric : []
  const idx = p.curIndex

  // 让当前行落在歌词框垂直中线
  const shift = useMemo(() => {
    if (idx < 0) return 0
    return -(idx * LINE + LINE / 2)
  }, [idx])

  const pct = p.dur > 0 ? Math.min(100, (p.pos / p.dur) * 100) : 0

  return (
    <div className="np" role="dialog" aria-label="正在播放">
      <div className="np-bg" aria-hidden="true" />
      {p.cur?.cover ? (
        <div className="np-bg-cover" style={{backgroundImage: `url(${p.cur.cover})`}} aria-hidden="true" />
      ) : null}

      <header className="np-top">
        <button className="np-back" onClick={p.onClose} title="返回 (Esc)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="np-crumb">
          <span className="np-label">NOW PLAYING</span>
          <span className="np-crumb-title">{p.cur ? p.cur.name : '未在播放'}</span>
        </div>
        {p.busy && <span className="np-busy">取流中…</span>}
      </header>

      <div className="np-body">
        <div className="np-left">
          <div className="np-cover"
               style={p.cur?.cover
                 ? {backgroundImage: `url("${p.cur.cover}"), ${COVER_GRAD}`}
                 : {background: COVER_GRAD}} />
          <div className="np-title">{p.cur ? p.cur.name : '未在播放'}</div>
          <div className="np-artist">
            {p.cur ? (p.cur.artist || '未知歌手') + (p.cur.album ? ' — ' + p.cur.album : '') : '选一首歌开始'}
          </div>
          <div className="np-ops">
            <button className={'np-chip' + (p.inLib ? ' on' : '')} onClick={p.onFav} disabled={!p.cur}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <path d="M12 19.4C7.2 16.2 4 13.4 4 10.1A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 8 2.1c0 3.3-3.2 6.1-8 9.3z" />
              </svg>
              {p.inLib ? '已收藏' : '收藏'}
            </button>
            {p.cur?.source === 'plugin' && p.cur.plug ? <span className="np-chip static">{p.cur.plug}</span> : null}
            {p.errText ? <span className="np-err">{p.errText}</span> : null}
          </div>
        </div>

        <div className="np-right">
          <div className="np-lyric-box">
            {lines.length === 0 ? (
              <div className="np-lyric-empty">
                {p.isLive ? '电台直播没有歌词' : '这首歌暂时没有歌词'}
              </div>
            ) : (
              <div className="np-lyric-lines" style={{transform: `translateY(${shift}px)`}}>
                {lines.map((l, i) => (
                  <div
                    key={i + l.time}
                    className={'np-line' + (i === idx ? ' on' : '')}
                    style={{height: LINE + 'px', lineHeight: LINE + 'px'}}
                    onClick={() => p.onSeek(l.time)}
                  >{l.text || ' '}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        {p.queue.length > p.queueIdx + 1 && (
          <aside className="np-queue" aria-label="播单">
            <div className="npq-head">
              播单<em>{p.queue.length - p.queueIdx - 1}</em>
            </div>
            <div className="npq-list">
              {p.queue.slice(p.queueIdx + 1).map((t, k) => (
                <div key={t.id + k} className="npq-row" onClick={() => p.onPlayAt(p.queueIdx + 1 + k)}
                     title={'播放：' + t.name}>
                  <span className="npq-n">{k + 1}</span>
                  <div className="npq-info">
                    <b>{t.name}</b>
                    <em>{t.artist || '未知歌手'}</em>
                  </div>
                  <button className="npq-x" title="移出待播"
                          onClick={(e) => { e.stopPropagation(); p.onRemove(p.queueIdx + 1 + k) }}>×</button>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      <div className="np-bottom">
        {p.isLive ? (
          <div className="np-live"><span className="live-dot" />直播中 · 内容随电台实时变化</div>
        ) : (
          <>
            <div className="np-prog">
              <span className="np-time">{fmt(p.pos)}</span>
              <input
                type="range" min={0} max={p.dur || 1} value={Math.min(p.pos, p.dur || 1)}
                onChange={(e) => p.onSeek(Number(e.target.value))}
                className="np-range"
                style={{background: `linear-gradient(to right, var(--np-acc) ${pct}%, var(--np-track) ${pct}%)`}}
              />
              <span className="np-time">{fmt(p.dur)}</span>
            </div>
          </>
        )}

        <div className="np-controls">
          <button className={'np-ctrl' + (p.shuffle ? ' on' : '')} onClick={p.onShuffle} title="随机播放">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h3.6l9.4 10h4M3 17h3.6l3.1-3.3" />
              <path d="M17 7h2.6M16.4 4.2 19.6 7l-3.2 2.8M16.4 14.2 19.6 17l-3.2 2.8" />
            </svg>
          </button>
          <button className="np-ctrl" onClick={p.onPrev} disabled={!p.cur} title="上一首">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="5" width="2.2" height="14" rx="1" />
              <path d="M19 5.6v12.8L8.6 12z" />
            </svg>
          </button>
          <button className="np-play" onClick={p.onToggle} disabled={!p.cur} title="播放 / 暂停">
            {p.playing ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="7.4" y="4.5" width="3.4" height="15" rx="1.1" />
                <rect x="13.2" y="4.5" width="3.4" height="15" rx="1.1" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.5 4.8v14.4L19.4 12z" />
              </svg>
            )}
          </button>
          <button className="np-ctrl" onClick={p.onNext} disabled={!p.cur} title="下一首">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="17.8" y="5" width="2.2" height="14" rx="1" />
              <path d="M5 5.6v12.8L15.4 12z" />
            </svg>
          </button>
          <button className={'np-ctrl' + (p.repeat ? ' on' : '')} onClick={p.onRepeat} title="单曲循环">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 9.5a5 5 0 0 1 4.9-5H17" /><path d="M15 2.6 18.4 4.6 15 6.6" />
              <path d="M19.5 14.5a5 5 0 0 1-4.9 5H7" /><path d="M9 21.4 5.6 19.4 9 17.4" />
            </svg>
          </button>
        </div>

        <div className="np-vol">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9.2v5.6h3.2L12 18.4V5.6L7.2 9.2H4z" />
            <path d="M15.2 8.6a4.6 4.6 0 0 1 0 6.8" />
          </svg>
          <input
            type="range" min={0} max={100} value={Math.round(p.volume * 100)}
            onChange={(e) => p.onVolume(Number(e.target.value) / 100)}
            className="np-range small"
            style={{background: `linear-gradient(to right, var(--np-acc) ${p.volume * 100}%, var(--np-track) ${p.volume * 100}%)`}}
          />
        </div>
      </div>
    </div>
  )
}
