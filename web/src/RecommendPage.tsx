/* 「推荐」页：把 MusicFree 插件自己提供的歌单浏览接口画出来。
     getRecommendSheetTags  → 分类（置顶 + 分组）
     getRecommendSheetsByTag → 该分类下的歌单/专辑卡片
     getMusicSheetInfo      → 点开一张卡片的曲目列表
   没有这三个方法的音源（多数只做搜索的源，或者 MyGo 目录型插件）给一句人话提示。 */

import {useCallback, useEffect, useState} from 'react'
import {pluginHasReco, pluginRecoTags, pluginRecoSheets, pluginRecoTracks, type RecoSheet, type RecoTag} from './pluginRuntime'

type Plugin = {id: string; name: string; kind?: string}
type Item = Record<string, any>

function fmt(sec: number) {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + String(s).padStart(2, '0')
}

// 封面没有时画一个音符，比用 ▣ 之类的字符靠谱（很多系统字体没这些字形）
function CoverIcon() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V6.5l9-2V16" />
      <circle cx="6.6" cy="18" r="2.4" />
      <circle cx="15.6" cy="16" r="2.4" />
    </svg>
  )
}

export default function RecommendPage({
  plugins,
  pluginId,
  onPlayItem,
  onPlayAll,
}: {
  plugins: Plugin[]
  pluginId: string
  onPlayItem: (pluginId: string, pluginName: string, items: Item[], index: number) => void
  onPlayAll: (pluginId: string, pluginName: string, items: Item[]) => void
}) {
  const enabled = plugins.filter((p) => !!p.id)
  const cur = enabled.find((p) => p.id === pluginId) || enabled[0] || null

  const [supported, setSupported] = useState<boolean | null>(null)
  const [pinned, setPinned] = useState<RecoTag[]>([])
  const [groups, setGroups] = useState<{title: string; data: RecoTag[]}[]>([])
  const [tag, setTag] = useState<RecoTag | null>(null)
  const [sheets, setSheets] = useState<RecoSheet[]>([])
  const [detail, setDetail] = useState<{sheet: RecoSheet; tracks: Item[]} | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const pid = cur?.id || ''
  const pname = cur?.name || ''

  // 分类：进页面先问一次插件的 getRecommendSheetTags
  const loadTags = useCallback(async (id: string) => {
    if (!id) {
      setSupported(false)
      return
    }
    setLoading(true)
    setErr('')
    try {
      const ok = await pluginHasReco(id)
      setSupported(ok)
      if (!ok) {
        setPinned([])
        setGroups([])
        setSheets([])
        setTag(null)
        return
      }
      const r = await pluginRecoTags(id)
      setPinned(r.pinned)
      setGroups(r.groups)
      const first = r.pinned[0] || (r.groups[0] && r.groups[0].data[0]) || null
      setTag(first)
    } catch (e: any) {
      setErr(String(e?.message || e))
      setSupported(false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setDetail(null)
    setSheets([])
    loadTags(pid)
  }, [pid, loadTags])

  // 换分类就换一页歌单
  useEffect(() => {
    if (!tag || !pid) return
    let alive = true
    setLoading(true)
    setErr('')
    setDetail(null)
    pluginRecoSheets(pid, tag, 1)
      .then((r) => {
        if (!alive) return
        setSheets(r.list)
      })
      .catch((e: any) => {
        if (alive) setErr(String(e?.message || e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tag?.id, pid])

  async function openSheet(s: RecoSheet) {
    if (!pid) return
    setLoading(true)
    setErr('')
    try {
      const r = await pluginRecoTracks(pid, s, 1)
      setDetail({sheet: s, tracks: r.list})
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  if (!enabled.length) {
    return (
      <div className="home">
        <div className="home-empty">
          <b>还没有音源插件</b>
          <p>先去「插件」页装一个，推荐页读的是插件自己给的歌单。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="home">
      {err && <div className="home-err">{err}</div>}

      {detail ? (
        <>
          <div className="home-detail-h">
            <button className="home-btn" onClick={() => setDetail(null)}>← 回到推荐</button>
            <h3>{detail.sheet.title}</h3>
            <span className="home-count">{detail.tracks.length} 首</span>
            {!!detail.tracks.length && (
              <button className="home-btn primary" onClick={() => onPlayAll(pid, pname, detail.tracks)}>播放全部</button>
            )}
          </div>
          <div className="home-list">
            {detail.tracks.map((t, i) => (
              <button key={String(t.id || '') + i} className="home-tr" onClick={() => onPlayItem(pid, pname, detail.tracks, i)}>
                <span className="home-tr-cover" style={t.artwork ? {backgroundImage: `url("${t.artwork}")`} : undefined}>
                  {t.artwork ? '' : <CoverIcon />}
                </span>
                <span className="home-tr-name">{t.title}</span>
                <span className="home-tr-sub">{t.artist}</span>
                <span className="home-tr-dur">{fmt(Number(t.duration) || 0)}</span>
              </button>
            ))}
            {!detail.tracks.length && !loading && <div className="home-empty"><p>这张歌单是空的</p></div>}
          </div>
        </>
      ) : (
        <>
          <div className="home-head">
            <h2 className="home-title">{pname ? pname + ' 推荐' : '推荐'}</h2>
            <div className="home-actions">
              <button className="home-btn" onClick={() => loadTags(pid)} disabled={loading}>
                {loading ? '加载中…' : '刷新'}
              </button>
            </div>
          </div>

          {supported === false && !loading && (
            <div className="home-empty">
              <p>这个音源没有推荐页</p>
              <p style={{opacity: 0.7}}>
                {cur && cur.kind === 'musicfree'
                  ? '它只提供了搜索接口。换成支持歌单浏览的源，或者直接去搜索页找歌。'
                  : 'MyGo 插件的内容在「首页」里浏览。'}
              </p>
            </div>
          )}

          {supported && (
            <div className="reco-chips">
              {pinned.map((t) => (
                <button key={'p:' + t.id} className={'reco-chip' + (tag?.id === t.id ? ' on' : '')} onClick={() => setTag(t)}>
                  {t.title}
                </button>
              ))}
              {groups.map((g) => (
                <div className="reco-group" key={g.title}>
                  {g.title && <span className="reco-group-t">{g.title}</span>}
                  {g.data.map((t) => (
                    <button key={'g:' + t.id} className={'reco-chip' + (tag?.id === t.id ? ' on' : '')} onClick={() => setTag(t)}>
                      {t.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {supported && loading && !sheets.length && <div className="home-empty"><p>正在读歌单…</p></div>}

          {supported && !!sheets.length && (
            <div className="home-row">
              {sheets.map((s, i) => (
                <button key={String(s.id) + i} className="home-card" onClick={() => openSheet(s)} title={s.title}>
                  <span className="home-cover" style={s.artwork ? {backgroundImage: `url("${s.artwork}")`} : undefined}>
                    {s.artwork ? '' : <CoverIcon />}
                  </span>
                  <span className="home-name">{s.title}</span>
                  <span className="home-artist">{s.description}</span>
                </button>
              ))}
            </div>
          )}

          {supported && !loading && !sheets.length && (
            <div className="home-empty"><p>这个分类下没有歌单，换个分类试试</p></div>
          )}
        </>
      )}
    </div>
  )
}
