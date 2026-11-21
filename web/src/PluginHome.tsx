/* 主面板「首页」：把当前插件 home() 返回的分区画出来。
   MyGo 插件给的是 JSON（title + sections），不是网页，所以这里是我们自己的
   UI —— 一行一组卡片（歌曲 / 专辑 / 歌单），点「更多」走插件的 browse(page)，
   点专辑或歌单走 album(id) / playlist(id) 换成一整页曲目列表。 */

import {useCallback, useEffect, useRef, useState} from 'react'
import {
  mygoAlbumTracks,
  mygoBrowseView,
  mygoHomeView,
  mygoPlaylistTracks,
  mygoShowTracks,
  type CardKind,
  type HomeCard,
  type HomeSection,
  type HomeView,
  type MyGoItem,
} from './mygoRuntime'

type Plugin = {id: string; name: string}

const PAGE_KEY = 'qqjt-home-page'

const KIND_LABEL: Record<string, string> = {album: '专辑', playlist: '歌单', station: '电台', show: '节目', artist: '艺人', link: '链接'}

// 封面缺失时画个类目图标。用内联 SVG 而不是 ▣ ◉ 这类字符 ——
// 有些系统字体里根本没有这些字形，界面上会变成小方框。
function KindIcon({kind}: {kind: string}) {
  const p = {width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'} as any
  if (kind === 'album') return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="12" cy="12" r="3" /></svg>
  if (kind === 'playlist') return <svg {...p}><path d="M4 6h11M4 11h11M4 16h7" /><path d="M18 8v7" /><circle cx="16" cy="17.4" r="2" /></svg>
  if (kind === 'station') return <svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2" /><path d="M12 4v2.5M12 17.5v2.5" /></svg>
  if (kind === 'show') return <svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" /></svg>
  if (kind === 'artist') return <svg {...p}><circle cx="12" cy="9" r="3.4" /><path d="M5.5 19c.7-3.4 3.2-5 6.5-5s5.8 1.6 6.5 5" /></svg>
  if (kind === 'link') return <svg {...p}><path d="M14 5h5v5M19 5l-7 7M9 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3" /></svg>
  return <svg {...p}><path d="M9 18V6.5l9-2V16" /><circle cx="6.6" cy="18" r="2.4" /><circle cx="15.6" cy="16" r="2.4" /></svg>
}

function fmt(sec: number) {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + String(s).padStart(2, '0')
}

export default function PluginHome({
  plugins,
  pluginId,
  onPlayItem,
  onPlayAll,
}: {
  plugins: Plugin[]
  pluginId: string
  onPlayItem: (pluginId: string, pluginName: string, items: MyGoItem[], index: number) => void
  onPlayAll: (pluginId: string, pluginName: string, items: MyGoItem[]) => void
}) {
  const [view, setView] = useState<HomeView | null>(null)
  const [page, setPage] = useState<string>(() => localStorage.getItem(PAGE_KEY) || '')
  const [detail, setDetail] = useState<{name: string; tracks: MyGoItem[]; kind: CardKind; id: string; more: boolean} | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const enabled = plugins.filter((p) => !!p.id)
  const cur = enabled.find((p) => p.id === pluginId) || enabled[0]

  useEffect(() => {
    if (!cur) setView(null)
  }, [cur?.id])

  const load = useCallback(async (pluginId: string, p: string) => {
    if (!pluginId) return
    // MusicFree 插件没有 home / browse 概念：直接提示去搜索，而不是抛一堆看不懂的错误。
    // 注意这里必须用 plugins 现价（依赖 plugins），用外层 enabled 会被 useCallback 的
    // 旧闭包冻住 —— 老版本就是这样：首次渲染 enabled 还是空的，于是永远判不到 musicfree，
    // 一路按 MyGo 去执行，最后报「插件只支持相对路径 import：axios」。
    const plug = plugins.find((x: any) => x.id === pluginId) as any
    if (plug?.kind === 'musicfree') {
      setView(null)
      setErr('')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr('')
    setDetail(null)
    try {
      const v = p ? await mygoBrowseView(pluginId, p) : await mygoHomeView(pluginId)
      setView(v)
    } catch (e: any) {
      setView(null)
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [plugins])

  // 换了音源就回到第一页，同一音源里翻页才跟着 page 走 —— 两件事不能混在一个 effect 里
  const prevPid = useRef('')
  useEffect(() => {
    if (!cur) return
    const switched = prevPid.current !== cur.id
    prevPid.current = cur.id
    if (switched) {
      setPage('')
      setDetail(null)
      load(cur.id, '')
      return
    }
    load(cur.id, page)
  }, [cur?.id, page])

  async function openCard(kind: CardKind, id: string) {
    if (!cur || !id) return
    // 链接卡（小宇宙的「按分类浏览 / 收听历史」）不是打开内容，而是切到插件的另一页
    if (kind === 'link') {
      if (/^https?:/.test(id)) {
        setErr('这张是外链（' + id + '），暂时只能在插件里点开')
        return
      }
      setErr('')
      setPage(id)
      localStorage.setItem(PAGE_KEY, id)
      return
    }
    setLoading(true)
    setErr('')
    try {
      let r: {name: string; tracks: MyGoItem[]; more?: boolean}
      if (kind === 'playlist') {
        r = {...(await mygoPlaylistTracks(cur.id, id).catch(() => mygoShowTracks(cur.id, id, kind))), more: false}
      } else if (kind === 'album') {
        r = {...(await mygoAlbumTracks(cur.id, id).catch(() => mygoShowTracks(cur.id, id, kind))), more: false}
      } else {
        r = await mygoShowTracks(cur.id, id, kind)
      }
      if (!r.tracks.length) {
        setErr('这张「' + (KIND_LABEL[kind] || kind) + '」打开后是空的，插件没给曲目')
        return
      }
      setDetail({name: r.name, tracks: r.tracks, kind, id, more: !!r.more})
    } catch (e: any) {
      setErr('打不开这张「' + (KIND_LABEL[kind] || kind) + '」：' + String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  // 小宇宙的一档播客往往几十上百集，插件按 offset 分页，这里接着往下拉
  async function loadMore() {
    if (!detail || !cur || loading) return
    setLoading(true)
    setErr('')
    try {
      const r = await mygoShowTracks(cur.id, detail.id, detail.kind, detail.tracks.length)
      const seen = new Set(detail.tracks.map((t) => t.id))
      const add = r.tracks.filter((t) => !seen.has(t.id))
      setDetail({...detail, tracks: [...detail.tracks, ...add], more: !!r.more && !!add.length})
    } catch (e: any) {
      setErr('加载更多失败：' + String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  if (!enabled.length) {
    return (
      <div className="home">
        <div className="home-empty">
          <b>还没有音源插件</b>
          <p>去左侧「插件」页装一个 MyGo 插件，装好回来这里就是它的首页。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="home">
      {err && <div className="home-err">插件返回错误：{err}</div>}

      {detail ? (
        <>
          <div className="home-detail-h">
            <button className="home-btn" onClick={() => setDetail(null)}>← 回到首页</button>
            <h3>{detail.name}</h3>
            <span className="home-count">{detail.tracks.length} 首</span>
            {!!detail.tracks.length && (
              <button className="home-btn primary" onClick={() => onPlayAll(cur!.id, cur!.name, detail.tracks)}>播放全部</button>
            )}
          </div>
          <div className="home-list">
            {detail.tracks.map((t, i) => (
              <button key={t.id + i} className="home-tr" onClick={() => onPlayItem(cur!.id, cur!.name, detail.tracks, i)}>
                <span className="home-tr-cover" style={t.artwork ? {backgroundImage: `url("${t.artwork}")`} : undefined}>
                  {t.artwork ? '' : <KindIcon kind="track" />}
                </span>
                <span className="home-tr-name">{t.title}</span>
                <span className="home-tr-sub">{t.artist}</span>
                <span className="home-tr-dur">{fmt(t.duration)}</span>
              </button>
            ))}
            {!detail.tracks.length && !loading && <div className="home-empty"><p>这个列表是空的</p></div>}
            {detail.more && (
              <button className="home-btn" style={{margin: '10px auto', display: 'block'}}
                      onClick={loadMore} disabled={loading}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="home-head">
            {view?.title && <h2 className="home-title">{view.title}</h2>}
            <div className="home-actions">
              {page && (
                <button className="home-btn" onClick={() => { setPage(''); localStorage.removeItem(PAGE_KEY) }}>返回首页</button>
              )}
              <button className="home-btn" onClick={() => load(cur!.id, page)} disabled={loading}>
                {loading ? '加载中…' : '刷新'}
              </button>
            </div>
          </div>
          {loading && !view && <div className="home-empty"><p>正在读插件首页…</p></div>}
          {!view && !loading && cur && (cur as any).kind === 'musicfree' && (
            <div className="home-empty">
              <p>这个 MusicFree 源没有首页推荐</p>
              <p style={{opacity: 0.7}}>去左边「搜索」里搜歌名或歌手，点结果就能播</p>
            </div>
          )}
          {view && !view.sections.length && !loading && <div className="home-empty"><p>插件首页没有内容</p></div>}
          {(view?.sections || []).map((sec: HomeSection, si: number) => (
            <section className="home-sec" key={si}>
              <div className="home-sec-h">
                <h3>{sec.title || '推荐'}</h3>
                {sec.subtitle && <span className="home-sub">{sec.subtitle}</span>}
                {sec.page && (
                  <button className="home-btn" onClick={() => { setPage(sec.page); localStorage.setItem(PAGE_KEY, sec.page) }}>更多</button>
                )}
              </div>
              <div className="home-row">
                {sec.tracks.map((t, i) => (
                  <button key={t.id + i} className="home-card track" onClick={() => onPlayItem(cur!.id, cur!.name, sec.tracks, i)}>
                    <span className="home-cover" style={t.artwork ? {backgroundImage: `url("${t.artwork}")`} : undefined}>
                      {t.artwork ? '' : <KindIcon kind="track" />}
                    </span>
                    <span className="home-name">{t.title}</span>
                    <span className="home-artist">{t.artist}</span>
                  </button>
                ))}
                {sec.cards.map((c: HomeCard, ci: number) => (
                  <button key={c.kind + ':' + c.id + ':' + ci} className="home-card"
                          onClick={() => openCard(c.kind, c.id)} title={c.name}>
                    <span className="home-cover" style={c.cover ? {backgroundImage: `url("${c.cover}")`} : undefined}>
                      {c.cover ? '' : <KindIcon kind={c.kind} />}
                    </span>
                    <span className="home-name">{c.name}</span>
                    <span className="home-artist">{c.sub}</span>
                  </button>
                ))}
                {!sec.tracks.length && !sec.cards.length && (
                  <div className="home-empty inline"><p>{sec.empty || '这一组是空的'}</p></div>
                )}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
