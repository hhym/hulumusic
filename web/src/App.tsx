import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import logoHulu from './assets/images/logo-hulu.png'
import './style.css'
import SettingsPage from './Settings'
import PluginsPage from './Plugins'
import NowPlaying from './NowPlaying'
import MiniPlayer from './MiniPlayer'
import SkinView from './SkinView'
import {NEXT_THEME, THEME_ICON, THEME_LABEL, type Theme} from './theme'
import {Fi, FN} from './feather'
import SignInModal, {type SignInRequest} from './SignInModal'
import {
  decodePluginTrackId,
  encodePluginTrack,
  pluginLyric,
  pluginMediaSource,
  pluginSearch,
} from './pluginRuntime'
import {mygoAccount, mygoSignIn, mygoSignOut, type MyGoItem} from './mygoRuntime'
import PluginHome from './PluginHome'
import {Equalizer, EQ_FREQS, EQ_PRESETS} from './eq'
import Visualizer from './Visualizer'

type Track = {id: string; name: string; artist: string; album: string; cover: string; duration: number; source: string; plug?: string}
type Chart = {id: string; name: string; cover: string; source: string}
type SearchResult = {tracks: Track[]; source: string; error: string; ms: number}
type LyricLine = {time: number; text: string}
// at：每首歌加入这个歌单的时间戳（毫秒），「按时间排序」要用；老数据没有就退回库里的顺序
type Playlist = {id: string; name: string; tracks: Track[]; at?: Record<string, number>}

// mygo-music 那个换皮宿主把窗口做成了无边框：系统标题栏没有了，页面得自己画
// 一条能拖动的顶部条 + 最小化/关闭两个按钮。Wails 版没有 window.mygo，不受影响。
const MYGO_HOST = typeof (window as any).mygo !== 'undefined'

// 桌面版单窗口：左侧导航 + 右侧内容 + 底部播放条；迷你卡是同一页面的缩小形态。
// 一个它自己的窗口。这些窗口靠 URL 参数区分自己是谁——windowed=1 表示"我是
// 附带的窗口，× 只关我自己"，mini=1 表示"一打开就是迷你卡"。
const START_PARAMS = (() => {
  try { return new URLSearchParams(window.location.search) } catch { return new URLSearchParams() }
})()
const OWNED_WIN = START_PARAMS.get('windowed') === '1'
const START_MINI = START_PARAMS.get('mini') === '1'

// 附带窗口里迷你卡的拖动交给 mygo 的 --app-region，不再自己算鼠标位移：
// 那样才不会把拖动消息打到别的窗口上去。
function markOwnedWin() {
  if (!OWNED_WIN) return
  const go = () => document.body.classList.add('qq-owned')
  if (document.body) go()
  else document.addEventListener('DOMContentLoaded', go, {once: true})
}

function markMygoHost() {
  if (!MYGO_HOST) return
  const go = () => document.body.classList.add('mygo-frameless')
  if (document.body) go()
  else document.addEventListener('DOMContentLoaded', go, {once: true})
}
// 无边框窗口那两个自绘按钮：先走我们自己的 Go 方法（最可靠），再补一发
// mygo 内置的窗口命令；预置 350ms 兜底，任一成功窗口就没了。
function closeApp() {
  const w: any = window
  // 迷你卡只是本页面的一个形态，关掉自己就够，绝不能退出整个应用。
  if (OWNED_WIN) {
    try { w.mygo?.runtime?.window?.close?.() } catch { /* 忽略 */ }
    return
  }
  try { w.go?.main?.App?.Quit?.() } catch { /* 忽略 */ }
  try { w.mygo?.runtime?.window?.close?.() } catch { /* 忽略 */ }
  window.setTimeout(() => { try { w.mygo?.runtime?.window?.close?.() } catch { /* 忽略 */ } }, 350)
}

function minimizeApp() {
  const w: any = window
  if (OWNED_WIN) {
    try { w.mygo?.runtime?.window?.minimize?.() } catch { /* 忽略 */ }
    return
  }
  try { w.go?.main?.App?.WinMinimize?.() } catch { /* 忽略 */ }
  try { w.mygo?.runtime?.window?.minimize?.() } catch { /* 忽略 */ }
}
markMygoHost()
markOwnedWin()

// 3.0 的默认外观：桌面界面「浅色」。
// 老用户的 localStorage 里存的是旧默认（紫夜 / 橘黄），只改 fallback 对他们完全不生效，
// 所以做一次性的默认外观迁移：标记不存在才覆盖一次，之后用户自己选的就不再动。
function applyDefaultLookOnce() {
  try {
    if (localStorage.getItem('qqjt-look-300')) return
    localStorage.setItem('hulu-theme', 'light')
    localStorage.setItem('qqjt-skin', 'glass')
    localStorage.setItem('qqjt-look-273', '1')
    localStorage.setItem('qqjt-look-276', '1')
    localStorage.setItem('qqjt-look-300', '1')
  } catch { /* 忽略 */ }
}
applyDefaultLookOnce()

// 拼音排序：WebView2 自带的 ICU 有中文 pinyin collation，不用再塞一张拼音表。
// 环境不支持时 resolvedOptions 不会报 pinyin，退化成普通 zh 比较，绝不抛错。
const PINYIN_COLLATOR = (() => {
  try {
    // TS 的标准库 CollatorOptions 没写 collation，但它确实是 ICU 支持的（ECMA-402 扩展），只能断言
    const c = new Intl.Collator('zh-Hans', {collation: 'pinyin', numeric: true, sensitivity: 'base'} as any)
    if (c.resolvedOptions().collation === 'pinyin') return c
  } catch { /* 忽略 */ }
  try { return new Intl.Collator('zh-Hans', {numeric: true, sensitivity: 'base'}) } catch { return null }
})()
const cmpPinyin = (a: string, b: string) =>
  PINYIN_COLLATOR ? PINYIN_COLLATOR.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0)
// 「按名称」按字面（UTF-16 码位）排，和「按拼音」区分开：英文/数字两者一样，中文只有拼音那个才符合直觉
const cmpRaw = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 自建歌单存在 localStorage，跟着曲子一起存（换台机器/换插件都还能用）
const PL_KEY = 'qqjt-playlists'
function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(PL_KEY)
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr
      .filter((p: any) => p && typeof p.id === 'string' && Array.isArray(p.tracks))
      .map((p: any) => ({
        id: p.id,
        name: String(p.name || '歌单'),
        tracks: p.tracks as Track[],
        at: (p.at && typeof p.at === 'object') ? p.at as Record<string, number> : undefined,
      }))
  } catch { return [] }
}

const G = () => (window as any).go?.main?.App


// Wails 把 Go 的 (数据, 错误) 双返回值合并成"单值 union"：
// 成功时直接返回数据，失败时返回错误字符串。绝不能按 [data, err] 解构，
// 否则解构出来的"err"其实是数据里的元素（曾导致把 Track 对象渲染进 JSX 而崩）。
async function callResult<T>(fn: string, ...args: any[]): Promise<{data: T | null; err: string}> {
  const r: any = await call<any>(fn, ...args)
  // Go 的 (数据, 错误) 有时被 Wails 打包成 [数据, 错误]，有时直接给数据。
  // 只有「两元素且第二个是字符串」才按双返回值拆，避免把双元素列表误拆。
  if (Array.isArray(r) && r.length === 2 && typeof r[1] === 'string') {
    return {data: (r[0] ?? null) as T | null, err: r[1]}
  }
  if (Array.isArray(r)) return {data: r as T, err: ''}
  if (typeof r === 'string' && r.trim()) return {data: null, err: r}
  return {data: null, err: ''}
}

const toArr = <T,>(x: any): T[] => (Array.isArray(x) ? (x as T[]) : [])

async function call<T>(fn: string, ...args: any[]): Promise<T> {
  const app = G()
  if (!app || typeof app[fn] !== 'function') throw new Error('后端未就绪')
  return await app[fn](...args)
}

const fmt = (ms: number) => {
  if (!ms || !isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const BUILD_TAG = '3.0.30'
const srcName = (s: string) =>
  s === 'qq' ? 'QQ' : s === 'ne' ? '网易云'
  : s === 'plugin' ? '插件' : s === 'local' ? '本地' : s

type Tab = 'home' | 'search' | 'library' | 'local' | 'queue' | 'lyric' | 'plugins' | 'settings'

export default function App() {
  // 主题：记住用户选择；没存过就用浅色（默认），四档循环是 浅 → 橘黄 → 深青 → 深色。
  // localStorage 在某些 WebView2 环境里会抛异常，全部包起来，绝不能因此白屏。
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('hulu-theme')
      if (saved === 'dark' || saved === 'light' || saved === 'amber' || saved === 'teal' || saved === 'green') return saved
    } catch { /* 忽略 */ }
    return 'light'
  })
  const [tab, setTab] = useState<Tab>('home')
  const [q, setQ] = useState('千千阙歌')
  // 桌面版左侧歌单：按专辑把收藏分组，点一下只看这张
  const [libAlbum, setLibAlbum] = useState('')
  // 自建歌单
  const [pls, setPls] = useState<Playlist[]>(loadPlaylists)
  const [plSel, setPlSel] = useState('')
  const [plNew, setPlNew] = useState(false)
  const [plName, setPlName] = useState('')
  // 歌单排序：manual = 拖动排的顺序；time/name/pinyin 只是视图排序，不改歌单本身
  type SortMode = 'manual' | 'time' | 'name' | 'pinyin'
  const [plSort, setPlSort] = useState<SortMode>(() => {
    try {
      const v = localStorage.getItem('qqjt-plsort')
      if (v === 'manual' || v === 'time' || v === 'name' || v === 'pinyin') return v
    } catch { /* 忽略 */ }
    return 'manual'
  })
  const setSortMode = (m: SortMode) => {
    setPlSort(m)
    try { localStorage.setItem('qqjt-plsort', m) } catch { /* 忽略 */ }
  }
  const [dragFrom, setDragFrom] = useState(-1)
  const [dragOver, setDragOver] = useState(-1)
  const [plDel, setPlDel] = useState('')
  const [plMenu, setPlMenu] = useState<{t: Track; x: number; y: number} | null>(null)
  // 歌单批量：选择模式、已勾选的 id、批量「加入歌单」浮层、移出的二次确认
  const [selMode, setSelMode] = useState(false)
  const [selIds, setSelIds] = useState<string[]>([])
  const [bulkPl, setBulkPl] = useState<{x: number; y: number} | null>(null)
  const [bulkDel, setBulkDel] = useState(false)
  const [plNewBulk, setPlNewBulk] = useState<Track[] | null>(null)
  // 歌单重命名：正在改名的歌单 id + 输入框里的临时名字
  const [plRename, setPlRename] = useState<{id: string, name: string} | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErrState] = useState('')
  // 搜索失败若是因为没登录，这里放插件信息，界面上给一个扫码入口
  const [needLogin, setNeedLogin] = useState<{id: string; name: string}[]>([])
  const setErr = (v: any) => setErrState(v == null ? '' : typeof v === 'string' ? v : String(v))
  const [list, setList] = useState<Track[]>([])
  const [meta, setMeta] = useState('')

  const [settings, setSettings] = useState<any>(null)
  // 插件扫码登录：把 host.signInPrompt 的内容显示成二维码
  const [signInReq, setSignInReq] = useState<SignInRequest | null>(null)
  const [plugins, setPlugins] = useState<any[]>([])
  // 当前音源：主面板首页跟着它走，侧栏品牌位就是它的翻页切换器
  const [homePid, setHomePid] = useState<string>(() => localStorage.getItem('qqqt-home-plugin') || '')
  const [plMenuOpen, setPlMenuOpen] = useState(false)
  useEffect(() => {
    if (!plMenuOpen) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlMenuOpen(false) }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [plMenuOpen])
  const enabledPl: any[] = plugins.filter((p: any) => p.id)
  const plIdx = Math.max(0, enabledPl.findIndex((p: any) => p.id === homePid))
  const curPlugin = enabledPl[plIdx]
  // 无边框窗口自绘的最大化：交给 Go 的 ToggleMax 算工作区，它返回切换后的状态
  function toggleMaxApp() {
    const w: any = window
    const fn = w.go?.main?.App?.ToggleMax
    if (typeof fn !== 'function') return
    try {
      Promise.resolve(fn()).then((v: any) => setMaxedApp(!!v)).catch(() => { /* 忽略 */ })
    } catch { /* 忽略 */ }
  }

  function pickPlugin(id: string) {
    setHomePid(id)
    localStorage.setItem('qqqt-home-plugin', id)
    setPlMenuOpen(false)
    setTab('home')
  }
  const [lib, setLib] = useState<Track[]>([])

  // 播放器
  const [cur, setCur] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [lyric, setLyric] = useState<LyricLine[]>([])
  const [busy, setBusy] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)

  // 二级播放界面
  const [npOpen, setNpOpen] = useState(false)
  const [mini, setMini] = useState(START_MINI)
  // 竖向皮肤界面：窗口 480×1024，四面板纵向堆叠。
  const [skin, setSkin] = useState(false)
  // 窗口最大化状态：按钮图标要在「最大化 / 还原」之间换，所以得记着
  const [maxedApp, setMaxedApp] = useState(false)
  // 迷你模式下窗口缩成 348×124，mygo 那边是透明窗口：页面底色要让出来，
  // 只留那张带圆角的迷你卡，看起来才像贴在桌面上的浮卡。
  // 用 body 上的 class 而不是 CSS :has()，老一点的 WebView2 也认。
  useEffect(() => { document.body.classList.toggle('qq-mini', mini) }, [mini])
  const [volume, setVolumeState] = useState(0.5)
  const [shuffle, setShuffle] = useState(false)
  // 均衡器：10 段增益（dB）、前置增益、开关与预设序号
  const eqRef = useRef<Equalizer | null>(null)
  const [eqOn, setEqOn] = useState(false)
  const [eqGains, setEqGains] = useState<number[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('qqjt-eq') || '{}')
      if (Array.isArray(v.gains) && v.gains.length === EQ_FREQS.length) return v.gains.map((n: any) => Number(n) || 0)
    } catch { /* 忽略 */ }
    return EQ_FREQS.map(() => 0)
  })
  const [preamp, setPreamp] = useState<number>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('qqjt-eq') || '{}')
      if (typeof v.preamp === 'number' && v.preamp > 0) return v.preamp
    } catch { /* 忽略 */ }
    return 1
  })
  const [eqPreset, setEqPreset] = useState(-1)
  const eqReady = () => {
    const el = audio.current
    const eq = eqRef.current || (eqRef.current = new Equalizer())
    return {el, eq}
  }
  // 可视化要的分析节点：EQ 没开也建图（滤镜增益 0，等于旁路），建不起来就返回 null
  const ensureVis = useCallback(async () => {
    const el = audio.current
    if (!el) return null
    const eq = eqRef.current || (eqRef.current = new Equalizer())
    if (!eq.ready) {
      const ok = await eq.attach(el)
      if (!ok) return null
    }
    await eq.resume()
    return eq.analysts
  }, [])
  const toggleEq = async () => {    const {el, eq} = eqReady()
    if (eqOn) {
      eq.setEnabled(false)
      setEqOn(false)
      return
    }
    if (!el) return
    if (!eq.ready) {
      const ok = await eq.attach(el)
      if (!ok) {
        setErr('均衡器接不上当前音源：这路音频没有开放跨源读取（CORS），浏览器不允许做音效处理。换一首再试。')
        return
      }
    }
    eq.setGains(eqGains)
    eq.setPreamp(preamp)
    eq.setEnabled(true)
    await eq.resume()
    setEqOn(true)
  }
  const resetEq = () => {
    setEqGains(EQ_FREQS.map(() => 0))
    setPreamp(1)
    setEqPreset(0)
  }
  const nextPreset = () => {
    const i = (eqPreset + 1) % EQ_PRESETS.length
    setEqPreset(i)
    setEqGains(EQ_PRESETS[i].gains.slice())
  }

  // 歌词秀模式：karaoke = 卡拉OK 两行；scroll = 整段滚动（当前行同样逐字填充）
  const [lyricMode, setLyricMode] = useState<'karaoke' | 'scroll'>(() => {
    return localStorage.getItem('qqjt-lrcmode') === 'scroll' ? 'scroll' : 'karaoke'
  })
  const switchLyricMode = () => {
    const next = lyricMode === 'karaoke' ? 'scroll' : 'karaoke'
    setLyricMode(next)
    localStorage.setItem('qqjt-lrcmode', next)
  }
  const pickTheme = (t: Theme) => setTheme(t)
  const [repeatOne, setRepeatOne] = useState(false)
  // 播放队列（上一首 / 下一首）
  // 播放队列（上一首 / 下一首 / 播放列表页都用它）
  const [queue, setQueue] = useState<{list: Track[]; idx: number}>({list: [], idx: 0})

  // 本地乐库
  const [localTracks, setLocalTracks] = useState<Track[]>([])
  const [localDirs, setLocalDirs] = useState<string[]>([])
  const [localBusy, setLocalBusy] = useState(false)
  const [localInfo, setLocalInfo] = useState('')

  // 轻提示（登出成功之类）
  const [toast, setToast] = useState('')
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(t)
  }, [toast])

  // 已登录的插件账号：搜一次列出所有，界面上给个登出入口
  const [accounts, setAccounts] = useState<{id: string; name: string; who: string}[]>([])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('hulu-theme', theme)
    } catch { /* 忽略 */ }
  }, [theme])

  // 插件扫码登录：host.signInPrompt 抛上来的内容在这里接住，弹二维码窗
  // 搜索时插件报未登录：直接在这个位置发起扫码，成功后重搜一遍
  // 已登录插件探测：没有 account() 的插件会返回 null，直接跳过
  const refreshAccounts = useCallback(async () => {
    const list: {id: string; name: string; who: string}[] = []
    for (const p of plugins) {
      try {
        const acc = await mygoAccount(p.id)
        if (acc) {
          list.push({id: p.id, name: p.name || p.id, who: String(acc.name || acc.nickname || acc.id || '已登录')})
        }
      } catch { /* 没登录就是 null */ }
    }
    setAccounts(list)
  }, [plugins])

  useEffect(() => {
    void refreshAccounts()
  }, [refreshAccounts])

  // 打开设置页时重新探一次账号（登录可能是在插件页发生的）
  useEffect(() => {
    if (tab === 'settings') void refreshAccounts()
  }, [tab, refreshAccounts])

  // 插件页里登录/登出后，账号信息跟着变
  useEffect(() => {
    const h = () => { void refreshAccounts() }
    window.addEventListener('mygo-account-changed', h)
    return () => window.removeEventListener('mygo-account-changed', h)
  }, [refreshAccounts])

  async function signOutOne(id: string) {
    try {
      const who = await mygoSignOut(id)
      setAccounts((prev) => prev.filter((a) => a.id !== id))
      setToast(who.name ? '已登出 ' + who.name : '已登出')
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  async function signInThenSearch(id: string) {
    setErr('')
    try {
      await mygoSignIn(id)
      setNeedLogin([])
      doSearch()
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  useEffect(() => {
    const onPrompt = (e: any) => {
      const d = e?.detail || {}
      setSignInReq({
        qr: String(d.qr || ''),
        // 只有文字没二维码的提示（比如「Signed in」）也要能显示出来
        text: String(d.text || ''),
        pluginId: String(d.pluginId || ''),
        done: typeof d.done === 'function' ? d.done : () => {},
      })
    }
    window.addEventListener('mygo-signin-prompt', onPrompt)
    return () => window.removeEventListener('mygo-signin-prompt', onPrompt)
  }, [])

  useEffect(() => {
    call<any>('Plugins').then((p: any) => setPlugins(Array.isArray(p) ? p.filter((x: any) => x.enabled) : [])).catch(() => {})
    call<Track[]>('Library').then((l) => setLib(toArr<Track>(l))).catch(() => {})
    // 设置页保存的偏好：启动页、音量、主题
    call<any>('GetSettings')
      .then((st: any) => {
        if (!st || typeof st !== 'object') return
        setSettings(st)
        if (st.defaultTab && ['search', 'library', 'local', 'plugins', 'settings'].includes(st.defaultTab)) {
          setTab(st.defaultTab as Tab)
        }
        if (typeof st.volume === 'number') {
          setVolumeState(st.volume)
          if (audio.current) audio.current.volume = st.volume
        }
        // 主题以 localStorage 为准：点一下主题按钮只会写这里，settings.json 里存的还是上次保存的旧值。
        // 如果这里无条件把 st.theme 应用回去，用户换过主题后每次启动就会被旧值覆盖，所以只在没存过时兜底。
        let savedTheme = ''
        try { savedTheme = localStorage.getItem('hulu-theme') || '' } catch { /* 忽略 */ }
        if (!savedTheme && (st.theme === 'dark' || st.theme === 'light' || st.theme === 'amber' || st.theme === 'teal' || st.theme === 'green')) setTheme(st.theme as Theme)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (audio.current && settings && typeof settings.volume === 'number') {
      audio.current.volume = Math.min(1, Math.max(0, settings.volume))
    }
  }, [settings])

  useEffect(() => {
    if (audio.current) audio.current.volume = Math.min(1, Math.max(0, volume))
  }, [volume])

  // Esc 关闭二级页
  useEffect(() => {
    if (!npOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNpOpen(false)
      if (e.key === ' ' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [npOpen, cur])

  // 音源全部来自插件：并发打所有启用插件，合并结果
  async function activePlugins(): Promise<any[]> {
    try {
      const raw: any = await call<any>('Plugins')
      const list = Array.isArray(raw) ? raw : []
      const on = list.filter((p: any) => p.enabled)
      setPlugins(on)
      return on
    } catch {
      return plugins.filter((p: any) => p.enabled)
    }
  }

  async function doSearch() {
    if (!q.trim() || loading) return
    setLoading(true); setErr(''); setMeta(''); setList([]); setNeedLogin([])
    const t0 = Date.now()
    try {
      const act = await activePlugins()
      setTab('search')
      if (!act.length) {
        setErr('还没有音源插件。去左侧「插件」页装一个 MyGo 插件，装好后回来搜索。')
        return
      }
      const rs = await Promise.all(
        act.map(async (p: any) => {
          try {
            return { id: p.id, name: p.name, items: await pluginSearch(p.id, q.trim(), 1), err: '' }
          } catch (e: any) {
            return { id: p.id, name: p.name, items: [], err: String(e?.message || e) }
          }
        })
      )
      const flat: Track[] = []
      const errs: string[] = []
      const logins: {id: string; name: string}[] = []
      const looksLikeLogin = (m: string) => /登录|login|sign ?in|token|未授权|401|403|2001|-1000/i.test(m)
      for (const r of rs) {
        if (r.err) {
          errs.push(r.name + '：' + r.err)
          if (looksLikeLogin(r.err)) logins.push({id: r.id, name: r.name})
        }
        for (const it of r.items) {
          flat.push({
            id: encodePluginTrack(r.id, it as any),
            name: it.title || '未命名',
            artist: it.artist || '',
            album: it.album || '',
            cover: it.artwork || '',
            duration: Number(it.duration) || 0,
            source: 'plugin',
            plug: r.name,
          })
        }
      }
      setList(flat)
      setMeta(flat.length + ' 首 · ' + (Date.now() - t0) + ' ms')
      setNeedLogin(logins)
      if (errs.length) setErr(errs.join(' / '))
      if (!flat.length && !errs.length) setMeta('插件没搜到结果')
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally { setLoading(false) }
  }

  // 无边框窗口没有系统边框，宽度靠页面左右那 8px 的热区自己拖：
  // 记下按下时的屏幕 x 和当前宽度，移动时按屏幕坐标算目标宽度交给 Go
  // 的 ResizeEdge（拖左边时它会把窗口 x 一起挪，右边保持不动）。
  function startEdgeResize(dir: 'left' | 'right', e: any) {
    if (!MYGO_HOST || mini) return
    e.preventDefault?.()
    const startX = Number(e.screenX || 0)
    const startW = window.innerWidth
    let last = 0
    document.body.classList.add('edge-resizing')
    const move = (ev: any) => {
      const now = performance.now()
      if (now - last < 16) return
      last = now
      const dx = Number(ev.screenX || 0) - startX
      const w = Math.round(dir === 'right' ? startW + dx : startW - dx)
      call('ResizeEdge', w, dir).catch(() => {})
    }
    const up = () => {
      document.body.classList.remove('edge-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* 忽略 */ }
  }

  // 插件曲目 -> 播放队列里的 Track：id 里塞插件 id + 曲目 JSON，播放时还原
  function pluginTrack(pluginId: string, pluginName: string, it: MyGoItem): Track {
    return {
      id: encodePluginTrack(pluginId, it as any),
      name: it.title || '未命名',
      artist: it.artist || '',
      album: it.album || '',
      cover: it.artwork || '',
      duration: Number(it.duration) || 0,
      source: 'plugin',
      plug: pluginName,
    }
  }

  // 点首页某一张卡：把这一组曲目整个压进待播队列，从点的这首开始放
  function playPluginList(pluginId: string, pluginName: string, items: MyGoItem[], index: number) {
    const tracks = items.map((it) => pluginTrack(pluginId, pluginName, it))
    if (!tracks.length) return
    const i = Math.max(0, Math.min(index, tracks.length - 1))
    setQueue({list: tracks, idx: i})
    play(tracks[i], true)
  }

  async function play(t: Track, inQueue = false) {
    if (busy) return
    setBusy(true); setErr('')
    // 记录播放队列，供上一首 / 下一首使用
    if (!inQueue) {
      const srcList = tab === 'library' ? lib : tab === 'local' ? localTracks : list
      const qi = srcList.findIndex((x) => x.id === t.id)
      setQueue(qi >= 0 ? {list: srcList, idx: qi} : {list: [t], idx: 0})
    }
    try {
      let url = ''
      if (t.source === 'plugin') {
        const ref = decodePluginTrackId(t.id)
        if (!ref) throw new Error('插件曲目信息损坏，重新搜一次')
        const src = await pluginMediaSource(ref.pluginId, ref.item)
        const proxied: any = await call<any>('PluginPlayURL', src.url, src.referer || '')
        url = typeof proxied === 'string' && /^(http|blob|data):/.test(proxied) ? proxied : ''
        if (!url) throw new Error(typeof proxied === 'string' && proxied.trim() ? proxied : '插件取流失败')
      } else {
        const raw: any = await call<any>('StreamURL', t.id)
        url = typeof raw === 'string' && /^(http|blob|data):/.test(raw) ? raw : ''
        if (!url) { setErr(typeof raw === 'string' && raw.trim() ? raw : '拿不到播放地址'); return }
      }
      setCur(t); setLyric([]); setPos(0); setDur(0)
      const a = audio.current!
      a.src = url
      a.load()
      await a.play()
      setPlaying(true)
      if (t.source === 'ne' || t.source === 'qq' || t.source === 'local') {
        callResult<LyricLine[]>('Lyric', t.id)
          .then(({data}) => setLyric(toArr<LyricLine>(data)))
          .catch(() => {})
      } else if (t.source === 'plugin') {
        const ref = decodePluginTrackId(t.id)
        if (ref) pluginLyric(ref.pluginId, ref.item).then((l) => setLyric(toArr<LyricLine>(l))).catch(() => {})
      }
    } catch (e: any) {
      setErr(String(e?.message || e)); setPlaying(false)
    } finally { setBusy(false) }
  }

  function toggle() {
    const a = audio.current
    if (!a || !cur) return
    if (a.paused) { a.play(); setPlaying(true) } else { a.pause(); setPlaying(false) }
  }

  // 迷你播放器：窗口缩成一条并置顶（Go 端改尺寸），关掉时还原
  async function toggleMini(on: boolean) {
    setMini(on)
    setNpOpen(false)
    try {
      const msg = await call('SetMiniMode', on)
      // Go 端没切成（比如找不到主窗口）就把界面退回原样，别留半截迷你布局
      if (msg) {
        setMini(!on)
        setErr(String(msg))
      }
    } catch { /* 浏览器预览没有这个方法，忽略 */ }
  }

  // 竖向皮肤界面：窗口切到 480×1024（Go 端改尺寸），关掉还原桌面主界面。
  async function toggleSkin(on: boolean) {
    setSkin(on)
    setNpOpen(false)
    try {
      const msg = await call('SetSkinMode', on)
      if (msg) {
        setSkin(!on)
        setErr(String(msg))
      }
    } catch { /* 浏览器预览没有这个方法，忽略 */ }
  }

  // 队列切歌：shuffle 随机，否则首尾循环
  function step(delta: number) {
    const q = queue
    if (!q.list.length || busy) return
    let i = q.idx + delta
    if (shuffle && q.list.length > 1) {
      i = Math.floor(Math.random() * q.list.length)
    } else {
      if (i < 0) i = q.list.length - 1
      if (i >= q.list.length) i = 0
    }
    setQueue({list: q.list, idx: i})
    play(q.list[i], true)
  }

  // 播放列表里直接点某一首
  function playAt(i: number) {
    const q = queue
    if (!q.list[i]) return
    setQueue({list: q.list, idx: i})
    play(q.list[i], true)
  }

  // 从等待列表里去掉一首；删的是正在播的那首时，序号落到下一首
  function queueRemove(i: number) {
    setQueue((q) => {
      const list = q.list.filter((_, k) => k !== i)
      let idx = q.idx
      if (i < idx) idx -= 1
      else if (i === idx) idx = Math.min(idx, Math.max(0, list.length - 1))
      return {list, idx}
    })
  }

  function queueClear() {
    setQueue({list: [], idx: 0})
  }

  // 清空待播：保留正在播的那首，后面的全去掉
  function queueClearNext() {
    setQueue((q) => ({list: q.list.slice(0, Math.min(q.idx + 1, q.list.length)), idx: q.idx}))
  }

  // 待播/播放列表里的一行
  function qRow(t: Track, i: number, isCurrent: boolean) {
    const on = i === queue.idx
    return (
      <div key={t.id + i} className={'row' + (on ? ' on' : '')}>
        <button className="idx" onClick={() => playAt(i)}>{on && playing ? <Fi n="pause" size={12} /> : <Fi n="play" size={12} />}</button>
        <div className="cover" style={t.cover ? {backgroundImage: `url(${t.cover})`} : undefined} />
        <div className="info">
          <div className="name">{t.name}</div>
          <div className="ca">{t.artist || '未知艺人'}</div>
          <div className="cb">{t.album || ''}</div>
        </div>
        <span className="tag">{t.source === 'plugin' && t.plug ? t.plug : srcName(t.source)}</span>
        <span className="dur">{fmt(t.duration)}</span>
        {!isCurrent && <button className="rm" onClick={() => queueRemove(i)} title="从待播移除"><Fi n="x" size={11} /></button>}
      </div>
    )
  }

  // 加入待播：队空时直接开播，否则排到队尾，不动当前播放
  function enqueue(t: Track) {
    if (queue.list.length === 0) {
      setQueue({list: [t], idx: 0})
      play(t, true)
      setToast('队列是空的，直接放 · ' + t.name)
      return
    }
    setQueue((q) => {
      if (q.list.some((x) => x.id === t.id)) return q
      return {list: [...q.list, t], idx: q.idx}
    })
    if (queue.list.some((x) => x.id === t.id)) setToast('已经在待播里了 · ' + t.name)
    else setToast('已加入待播 · ' + t.name)
  }

  // 播完自动下一首 / 单曲循环
  function onEnded() {
    const a = audio.current
    if (!a) return
    if (repeatOne) { a.currentTime = 0; a.play().catch(() => {}); return }
    if (queue.list.length > 1) step(1)
    else setPlaying(false)
  }

  // 乐库：弹目录框 → 记住目录 → 扫描
  async function pickLocalDir() {
    const app: any = G()
    if (!app?.PickLocalDir) return
    setLocalBusy(true); setErr('')
    try {
      const r: any = await app.PickLocalDir()
      const [dir, e] = Array.isArray(r) ? r : [r, '']
      if (typeof e === 'string' && e.trim()) { setErr(e); return }
      if (!dir) return // 用户取消
      await scanLocalDir(dir)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally { setLocalBusy(false) }
  }

  async function scanLocalDir(dir: string) {
    const app: any = G()
    if (!app?.ScanLocalMusic) return
    setLocalBusy(true); setErr('')
    try {
      const r: any = await app.ScanLocalMusic(dir)
      // 新签名返回结构体 {tracks, scanned, audio, dirs, skipped, err}
      const scan = Array.isArray(r) ? (r[0] || {}) : (r || {})
      const tracks = toArr<Track>(scan.tracks)
      setLocalTracks(tracks)
      const stat = `扫过 ${scan.scanned ?? 0} 个文件（${scan.dirs ?? 0} 个目录），识别 ${tracks.length} 首`
      setLocalInfo(stat + (scan.skipped ? `，${scan.skipped} 项读不进去` : ''))
      if (scan.err) setErr(String(scan.err))
      const dirs: any = await app.LocalDirs?.()
      setLocalDirs(Array.isArray(dirs) ? dirs.map(String) : [])
      setTab('local')
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally { setLocalBusy(false) }
  }

  async function forgetLocalDir(dir: string) {
    const app: any = G()
    if (!app?.ForgetLocalDir) return
    try {
      const r: any = await app.ForgetLocalDir(dir)
      setLocalDirs(Array.isArray(r) ? r.map(String) : [])
    } catch { /* 忽略 */ }
  }

  async function fav(t: Track) {
    const next = await call<Track[]>('ToggleLibrary', t)
    setLib(toArr<Track>(next))
  }

  const curLine = useMemo(() => {
    if (!Array.isArray(lyric) || !lyric.length) return ''
    let line = ''
    for (const l of lyric) { if (l.time <= pos + 80) line = l.text; else break }
    return line
  }, [lyric, pos])

  // 当前歌词行索引，二级页用来高亮与滚动
  const curIndex = useMemo(() => {
    if (!Array.isArray(lyric) || !lyric.length) return -1
    let idx = -1
    for (let i = 0; i < lyric.length; i++) {
      if (lyric[i].time <= pos + 80) idx = i
      else break
    }
    return idx
  }, [lyric, pos])
  // 卡拉OK 填充比例：按「本句时间 → 下一句时间」线性推进
  const kProgress = useMemo(() => {
    if (!lyric.length || curIndex < 0) return 0
    const line = lyric[curIndex]
    const next = lyric[curIndex + 1]
    const end = next ? next.time : line.time + 3500
    const span = Math.max(250, end - line.time)
    const p = (pos - line.time) / span
    return p <= 0 ? 0 : p >= 1 ? 1 : p
  }, [lyric, curIndex, pos])

  useEffect(() => {
    const box = document.querySelector('.sk-lyr-body, .dlp-body') as HTMLElement | null
    const el = box ? (box.querySelector('.ln.on') as HTMLElement | null) : null
    if (box && el) {
      const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2
      box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
  }, [curIndex, cur?.id])

  // 均衡器：状态变化同步到音频图，并落本地
  useEffect(() => {
    eqRef.current?.setGains(eqGains)
  }, [eqGains])
  useEffect(() => {
    eqRef.current?.setPreamp(preamp)
    try {
      localStorage.setItem('qqjt-eq', JSON.stringify({gains: eqGains, preamp}))
    } catch { /* 忽略 */ }
  }, [preamp, eqGains])
  useEffect(() => {
    if (playing && eqRef.current) eqRef.current.resume()
  }, [playing])

  const curPl = pls.find((p) => p.id === plSel)
  const plTracks = curPl ? curPl.tracks : []
  const libView = plSel ? plTracks : (libAlbum ? lib.filter((t) => (t.album || '未分类') === libAlbum) : lib)
  const shownBase = Array.isArray(tab === 'library' ? libView : list) ? (tab === 'library' ? libView : list) : []
  // 能拖动的前提：正在看自建歌单，且排序模式是 manual（派生排序下拖动会自相矛盾）
  const canReorder = tab === 'library' && !!plSel && plSort === 'manual'
  const shown = (() => {
    if (tab !== 'library' || plSort === 'manual') return shownBase
    const at = curPl?.at || {}
    const posOf = new Map(shownBase.map((t, i) => [t.id, i]))  // 收藏库没记时间，用库里的顺序当加入序
    const arr = [...shownBase]
    if (plSort === 'time') {
      arr.sort((a, b) => (at[b.id] ?? posOf.get(b.id) ?? 0) - (at[a.id] ?? posOf.get(a.id) ?? 0))
    } else if (plSort === 'name') {
      arr.sort((a, b) => cmpRaw(a.name || '', b.name || ''))
    } else {
      arr.sort((a, b) => cmpPinyin(a.name || '', b.name || ''))
    }
    return arr
  })()

  // 桌面版左侧歌单：按专辑把收藏分组
  const albums = useMemo(() => {
    const m = new Map<string, {key: string; name: string; cover: string; n: number}>()
    for (const t of lib) {
      const k = t.album || '未分类'
      const e = m.get(k)
      if (e) e.n++
      else m.set(k, {key: k, name: k, cover: t.cover, n: 1})
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 10)
  }, [lib])

  // 歌单写进 localStorage：localStorage 可能抛异常（某些 WebView2 策略），绝不因此崩掉
  useEffect(() => {
    try { localStorage.setItem(PL_KEY, JSON.stringify(pls)) } catch { /* 忽略 */ }
  }, [pls])

  // 新建歌单（可以顺手把当前这首一起塞进去，避免 state 还没刷新时加歌失败）
  function newPlaylist(name: string, first?: Track, bulk?: Track[]) {
    const nm = name.trim() || ('歌单 ' + (pls.length + 1))
    const id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const tracks = first ? [first] : (bulk ? [...bulk] : [])
    const at: Record<string, number> = {}
    tracks.forEach((t) => { at[t.id] = Date.now() })
    setPls((list) => [...list, {id, name: nm, tracks, at}])
    setPlNew(false)
    setPlName('')
    setPlNewBulk(null)
    return id
  }
  // 歌单重命名：空名字视为取消，重名加后缀避免混淆
  function renamePlaylist(id: string, raw: string) {
    const nm = raw.trim()
    setPlRename(null)
    if (!nm) return
    setPls((list) => list.map((p) => {
      if (p.id !== id) return p
      if (p.name === nm) return p
      const dup = list.some((q) => q.id !== id && q.name === nm)
      return {...p, name: dup ? nm + ' (2)' : nm}
    }))
  }
  function commitRename() {
    if (plRename) renamePlaylist(plRename.id, plRename.name)
  }

  function delPlaylist(id: string) {
    setPls((list) => list.filter((p) => p.id !== id))
    if (plSel === id) setPlSel('')
    setPlDel('')
  }
  function addToPl(id: string, t: Track) {
    setPls((list) => list.map((p) => {
      if (p.id !== id) return p
      if (p.tracks.some((x) => x.id === t.id)) return p
      return {...p, tracks: [...p.tracks, t], at: {...(p.at || {}), [t.id]: Date.now()}}
    }))
  }
  // 拖动排序：只在「自建歌单 + manual」下开放，改的是歌单里真实的顺序
  function movePlTrack(from: number, to: number) {
    if (!plSel || from === to || from < 0 || to < 0) return
    setPls((list) => list.map((p) => {
      if (p.id !== plSel) return p
      if (from >= p.tracks.length || to >= p.tracks.length) return p
      const arr = [...p.tracks]
      const [moved] = arr.splice(from, 1)
      arr.splice(to, 0, moved)
      return {...p, tracks: arr}
    }))
  }

  // ── 歌单批量操作 ──
  function pickedSel(): Track[] {
    return shown.filter((t) => selIds.includes(t.id))
  }
  function toggleSel(id: string) {
    setSelIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]))
    setBulkDel(false)
  }
  function selectAllShown() {
    setSelIds(shown.map((t) => t.id))
    setBulkDel(false)
  }
  function exitSel() {
    setSelMode(false)
    setSelIds([])
    setBulkDel(false)
    setBulkPl(null)
  }
  function removeSelFromPl() {
    if (!plSel || !selIds.length) return
    const ids = new Set(selIds)
    setPls((list) => list.map((p) => (p.id === plSel ? {...p, tracks: p.tracks.filter((t) => !ids.has(t.id))} : p)))
    setSelIds([])
    setBulkDel(false)
  }
  function addSelToPl(pid: string) {
    const picked = pickedSel()
    if (picked.length) {
      setPls((list) => list.map((p) => {
        if (p.id !== pid) return p
        const add = picked.filter((t) => !p.tracks.some((x) => x.id === t.id))
        if (!add.length) return p
        const at = {...(p.at || {})}
        add.forEach((t) => { at[t.id] = Date.now() })
        return {...p, tracks: [...p.tracks, ...add], at}
      }))
    }
    setBulkPl(null)
    setSelIds([])
    setBulkDel(false)
  }
  function bulkToQueue() {
    pickedSel().forEach((t) => enqueue(t))
    setBulkDel(false)
  }

  function openPl(id: string) {
    setSelMode(false); setSelIds([])
    setPlSel(id)
    setLibAlbum('')
    setTab('library')
    call<Track[]>('Library').then((l) => setLib(toArr<Track>(l))).catch(() => {})
  }

  // 从批量选择里新建歌单：建完直接打开它，并把选择模式收掉
  function createFromNew() {
    const bulk = plNewBulk
    const id = newPlaylist(plName, undefined, bulk || undefined)
    if (bulk) {
      setSelMode(false)
      setSelIds([])
      openPl(id)
    }
  }

  function openLib(album = '') {
    setSelMode(false); setSelIds([])
    setPlSel('')
    setLibAlbum(album)
    setTab('library')
    call<Track[]>('Library').then((l) => setLib(toArr<Track>(l))).catch(() => {})
  }
  function openLocal() {
    setPlSel('')
    setLibAlbum('')
    setTab('local')
    const app = G()
    if (app?.LocalDirs) {
      app.LocalDirs().then((d: any) => setLocalDirs(Array.isArray(d) ? d.map(String) : [])).catch(() => {})
    }
  }

  const contentArea = (
    <main className="main">
      <header className={"head hd-" + tab}>
        <div>
          <h1 className={'page-h1 ph-' + tab}>{tab === 'home' ? '首页' : tab === 'library' ? '我的收藏' : tab === 'local' ? '歌曲' : tab === 'queue' ? '待播清单' : tab === 'plugins' ? '插件' : tab === 'settings' ? '设置' : tab === 'lyric' ? '歌词' : '搜索结果'}</h1>
          <p>{meta || (tab === 'home' ? '当前插件的首页，点卡片直接播' : tab === 'local' ? (localInfo || '选一个音乐文件夹，扫出来的歌直接播（同名 .lrc 会当歌词）') : tab === 'queue' ? '正在放的 + 接下来要放的，点一下就能跳过去' : tab === 'plugins' ? '导入 MyGo / MusicFree 插件，扩展音源' : tab === 'settings' ? '偏好设置，改完记得点保存' : tab === 'lyric' ? '跟着唱，可切卡拉OK 大行 / 整段滚动' : '输入关键词开始搜索')}</p>
        </div>
        {err && <div className="err">{err}</div>}
        {needLogin.length > 0 && (
          <div className="need-login">
            {needLogin.map((p) => (
              <button key={p.id} className="primary-btn" onClick={() => signInThenSearch(p.id)}>
                {p.name} 扫码登录
              </button>
            ))}
          </div>
        )}
      </header>

      {tab === 'home' ? (
        <PluginHome
          plugins={plugins}
          pluginId={homePid}
          onPlayItem={(pid, pname, items, i) => playPluginList(pid, pname, items, i)}
          onPlayAll={(pid, pname, items) => playPluginList(pid, pname, items, 0)}
        />
      ) : tab === 'lyric' ? (
        <div className="dlp">
          <div className="dlp-head">
            <div className="dlp-song">
              <b>{cur ? cur.name : '未在播放'}</b>
              <em>{cur ? ([cur.artist, cur.album].filter(Boolean).join(' · ') || '') : '选一首歌开始'}</em>
            </div>
            <div className="dlp-tools">
              <button className={lyricMode === 'karaoke' ? 'on' : ''} onClick={() => { if (lyricMode !== 'karaoke') switchLyricMode() }}>卡拉OK</button>
              <button className={lyricMode === 'scroll' ? 'on' : ''} onClick={() => { if (lyricMode !== 'scroll') switchLyricMode() }}>整段滚动</button>
            </div>
          </div>
          <div className="dlp-body">
            {lyric.length > 0 ? (
              lyricMode === 'karaoke' ? (
                <div className="dlp-kara">
                  <div className="dlp-prev">{curIndex > 0 ? lyric[curIndex - 1].text : ' '}</div>
                  <div className="dlp-now">
                    {curIndex >= 0 && lyric[curIndex] ? (
                      <span className="kowrap">
                        <span className="kbase">{lyric[curIndex].text}</span>
                        <span className="kfill" style={{ width: (kProgress * 100) + '%' }}>{lyric[curIndex].text}</span>
                      </span>
                    ) : (
                      <span className="kbase">…</span>
                    )}
                  </div>
                  <div className="dlp-next">{curIndex >= 0 && lyric[curIndex + 1] ? lyric[curIndex + 1].text : ' '}</div>
                </div>
              ) : (
                lyric.map((l, k) => (
                  k === curIndex ? (
                    <div key={k} className="ln on">
                      <span className="kowrap">
                        <span className="kbase">{l.text}</span>
                        <span className="kfill" style={{ width: (kProgress * 100) + '%' }}>{l.text}</span>
                      </span>
                    </div>
                  ) : (
                    <div key={k} className="ln">{l.text}</div>
                  ))
                )
              )
            ) : (
              <div className="dlp-none">{busy ? '取流中…' : cur ? '这首歌还没有歌词（同名 .lrc 会自动读取）' : '选一首歌开始'}</div>
            )}
          </div>
        </div>
      ) : tab === 'local' ? (
        <div className="local-page">
          <div className="local-head">
            <button className="primary-btn" onClick={pickLocalDir} disabled={localBusy}>
              {localBusy ? '扫描中…' : '选音乐文件夹'}
            </button>
            {localDirs.map((d) => (
              <span key={d} className="dir-chip" title={d}>
                {d}
                <button onClick={() => forgetLocalDir(d)} title="移出乐库">×</button>
              </span>
            ))}
          </div>
          {localTracks.length > 0 ? (
            <div className="list">
              <div className="thead">
                <span />
                <span />
                <div className="tinfo"><span>标题</span><span>艺人</span><span>专辑</span></div>
                <span>来源</span>
                <span>时长</span>
                <span />
                <span />
                <span />
              </div>
              {localTracks.map((t, i) => (
                <div key={t.id + i} className={'row' + (cur?.id === t.id ? ' on' : '')}>
                  <button className="idx" onClick={() => play(t)}>{playing && cur?.id === t.id ? <Fi n="pause" size={12} /> : <Fi n="play" size={12} />}</button>
                  <div className="cover" />
                  <div className="info">
                    <div className="name">{t.name}</div>
                    <div className="ca">{t.artist || '未知艺人'}</div>
                    <div className="cb">{t.album || ''}</div>
                  </div>
                  <span className="tag">本地</span>
                  <span className="dur">{fmt(t.duration)}</span>
                  <button className="add" onClick={() => enqueue(t)} title="加入待播"><Fi n="plus" size={12} /></button>
                  <button className={'heart' + (lib.some((x) => x.id === t.id) ? ' on' : '')} onClick={() => fav(t)}>♥</button>
                  <button className="addpl" title="加入自建歌单"
                          onClick={(e) => {
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                            setPlMenu({t, x: Math.max(8, Math.min(r.left - 196, window.innerWidth - 204)), y: r.bottom + 6})
                          }}>
                    <Fi n="folder" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">
              {localBusy
                ? '扫描中…'
                : localInfo
                  ? localInfo + '。没识别到音频文件？确认歌就在这个文件夹里（支持 mp3 / flac / m4a / aac / wav / ogg / opus / wma / ape）。'
                  : '还没扫到歌。点上面的按钮挑一个放音乐的文件夹。'}
            </div>
          )}
        </div>
      ) : tab === 'queue' ? (
        <div className="queue-page">
          <div className="queue-head">
            <span>
              {queue.list.length === 0
                ? '还没排歌'
                : `待播 ${Math.max(0, queue.list.length - queue.idx - 1)} 首` +
                  (queue.list[queue.idx] ? ` · 正在放 ${queue.list[queue.idx].name}` : '')}
            </span>
            <span className="q-ops">
              <button className="ghost-btn" onClick={queueClearNext} disabled={queue.list.length - queue.idx - 1 <= 0}>
                清空待播
              </button>
              <button className="ghost-btn" onClick={queueClear} disabled={!queue.list.length}>全部清空</button>
            </span>
          </div>

          {queue.list.length === 0 ? (
            <div className="empty">
              待播清单是空的。搜索结果或乐库每行右边的「＋」能把歌排进来，点歌名则会直接播。
            </div>
          ) : (
            <>
              {queue.list[queue.idx] && (
                <>
                  <div className="q-group">正在播放</div>
                  {qRow(queue.list[queue.idx], queue.idx, true)}
                </>
              )}

              <div className="q-group">
                待播清单
                <em>{Math.max(0, queue.list.length - queue.idx - 1)}</em>
              </div>
              {queue.list.length - queue.idx - 1 > 0 ? (
                <div className="list">
                  {queue.list.slice(queue.idx + 1).map((t, k) => qRow(t, queue.idx + 1 + k, false))}
                </div>
              ) : (
                <div className="empty q-tip">待播排空了。继续搜歌，或者在上面点「＋」把歌加进来。</div>
              )}

              {queue.idx > 0 && (
                <>
                  <div className="q-group dim">已播放<em>{queue.idx}</em></div>
                  <div className="list dim">
                    {queue.list.slice(0, queue.idx).map((t, k) => qRow(t, k, false))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : tab === 'settings' ? (
        <SettingsPage
          theme={theme}
          onTheme={(t) => pickTheme(t)}
          accounts={accounts}
          onSignOut={signOutOne}
          onRefreshAccounts={refreshAccounts}
        />
      ) : tab === 'plugins' ? (
        <PluginsPage onPlay={play} />
      ) : (
        <div className="list">
          <div className="thead">
                <span />
                <span />
                <div className="tinfo"><span>标题</span><span>艺人</span><span>专辑</span></div>
                <span>来源</span>
                <span>时长</span>
                <span />
                <span />
                <span />
              </div>
              {loading && <div className="empty">加载中…</div>}
          {!loading && shown.length === 0 && <div className="empty">还没有内容</div>}
          {!loading && shown.map((t, i) => (
            <div key={t.id + i}
                 className={'row' + (cur?.id === t.id ? ' on' : '') + (canReorder ? ' can-drag' : '')
                   + (dragFrom === i ? ' drag-src' : '') + (dragOver === i && dragFrom !== i ? ' drop-on' : '')}
                 draggable={canReorder}
                 onDragStart={canReorder ? (e) => { e.dataTransfer.effectAllowed = 'move'; setDragFrom(i); setDragOver(i) } : undefined}
                 onDragOver={canReorder ? (e) => {
                   e.preventDefault()
                   e.dataTransfer.dropEffect = 'move'
                   if (dragOver !== i) setDragOver(i)
                 } : undefined}
                 onDragLeave={canReorder ? () => { if (dragOver === i) setDragOver(-1) } : undefined}
                 onDrop={canReorder ? (e) => { e.preventDefault(); movePlTrack(dragFrom, i); setDragFrom(-1); setDragOver(-1) } : undefined}
                 onDragEnd={() => { setDragFrom(-1); setDragOver(-1) }}>
              {selMode && tab === 'library' && (
                <span className={'selchk' + (selIds.includes(t.id) ? ' on' : '')}
                      onClick={(e) => { e.stopPropagation(); toggleSel(t.id) }}
                      title="选上它">
                  {selIds.includes(t.id) ? '✓' : ''}
                </span>
              )}
              {canReorder && !selMode && <span className="dgrip" aria-hidden="true">⠿</span>}
              <button className="idx" onClick={() => play(t)}>{playing && cur?.id === t.id ? <Fi n="pause" size={12} /> : <Fi n="play" size={12} />}</button>
              <div className="cover" style={t.cover ? {backgroundImage: `url(${t.cover})`} : undefined} />
              <div className="info">
                <div className="name">{t.name}</div>
                <div className="ca">{t.artist || '未知艺人'}</div>
                <div className="cb">{t.album || ''}</div>
              </div>
              <span className="tag">{t.source === 'plugin' && t.plug ? t.plug : srcName(t.source)}</span>
              <span className="dur">{fmt(t.duration)}</span>
              <button className="add" onClick={() => enqueue(t)} title="加入待播"><Fi n="plus" size={12} /></button>
              <button className={'heart' + (lib.some((x) => x.id === t.id) ? ' on' : '')} onClick={() => fav(t)}>♥</button>
              <button className="addpl" title="加入自建歌单"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        const x = Math.max(8, Math.min(r.left - 196, window.innerWidth - 204))
                        setPlMenu({t, x, y: r.bottom + 6})
                      }}>
                <Fi n="folder" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      </main>
  )

  return (
    <div className={'app desk-mode' + (mini ? ' mini-mode' : '') + (skin ? ' skin-mode' : '')}>
      {!mini && !skin && (
        <>
          <div className="edge-resize left" title="拖这里改宽" onPointerDown={(e) => startEdgeResize('left', e)} />
          <div className="edge-resize right" title="拖这里改宽" onPointerDown={(e) => startEdgeResize('right', e)} />
        </>
      )}
      {MYGO_HOST && !mini && !skin && (
        <>
          {/* 拖动条只放标题：--app-region 是继承属性，按钮要是落在 drag 容器里，
              点击会被 mygo 当成拖窗口，click 事件就丢了 —— 所以按钮单独一层。 */}
          <div className="mygo-dragbar"><span className="mygo-bar-title">千千静听</span></div>
          <div className="mygo-winctl">
            <button className="mygo-win-btn" title="最小化" style={{'--app-region': 'no-drag'} as any}
                    onClick={minimizeApp}><Fi n="minus" size={12} /></button>
            <button className="mygo-win-btn max" title={maxedApp ? '还原窗口' : '最大化'}
                    style={{'--app-region': 'no-drag'} as any} onClick={toggleMaxApp}>
              <Fi n={FN(maxedApp ? 'contract' : 'expand')} size={12} />
            </button>
            <button className="mygo-win-btn close" title="关闭" style={{'--app-region': 'no-drag'} as any}
                    onClick={closeApp}><Fi n="x" size={12} /></button>
          </div>
        </>
      )}
      <div className="desk">
          <aside className="desk-nav">
            {/* 品牌位换成音源翻页器：左右箭头循环切换插件，中间显示当前音源，点它进首页 */}
            <div className="dn-user dnp">
              <button className="dnp-box" onClick={() => setPlMenuOpen((v) => !v)}
                      title={curPlugin ? '当前音源：' + curPlugin.name : '还没装音源插件'}>
                {curPlugin ? (
                  <>
                    <span className="dnp-badge">{String(curPlugin.name || '?').trim().slice(0, 1)}</span>
                    <div className="dnp-id">
                      <b>{curPlugin.name}</b>
                      <span className="dnp-sub">{enabledPl.length > 1 ? '共 ' + enabledPl.length + ' 个音源' : '音源'}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <img className="dn-ava" src={logoHulu} alt="" />
                    <div className="dnp-id"><b>千千静听</b><span className="dnp-sub">未装音源</span></div>
                  </>
                )}
                <Fi n="chevron-down" size={12} />
              </button>

              {plMenuOpen && (
                <>
                  <div className="dnp-mask" onClick={() => setPlMenuOpen(false)} />
                  <div className="dnp-menu">
                    {enabledPl.map((p: any, i: number) => (
                      <button key={p.id} className={p.id === curPlugin?.id ? 'on' : ''}
                              onClick={() => pickPlugin(p.id)} title={p.name}>
                        <span className="dnp-badge sm">{String(p.name || '?').trim().slice(0, 1)}</span>
                        <span className="dnp-name">{p.name}</span>
                        {p.id === curPlugin?.id && <span className="dnp-tick">✓</span>}
                      </button>
                    ))}
                    {!enabledPl.length && (
                      <button onClick={() => { setPlMenuOpen(false); setTab('plugins') }}>
                        <span className="dnp-name">还没装音源插件，去装一个</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="dn-cards">
              <div className="dn-card on" title={cur ? cur.name : '未在播放'}
                   style={cur?.cover ? {backgroundImage: `url("${cur.cover}")`} : undefined}>
                {!cur?.cover && <span>♪</span>}
              </div>
              <button className="dn-card add" onClick={() => setTab('search')} title="去搜索加歌">
                <Fi n="plus" size={17} />
              </button>
            </div>

            <nav className="dn-quick">
              <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}>
                <span className="dn-ico"><Fi n="home" size={14} /></span><span className="dn-lab">首页</span>
              </button>
              <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>
                <span className="dn-ico"><Fi n="search" size={14} /></span><span className="dn-lab">搜索</span>
              </button>
              <button className={(tab === 'library' && !plSel && !libAlbum) ? 'on' : ''} onClick={() => openLib('')}>
                <span className="dn-ico"><Fi n="heart" size={14} /></span><span className="dn-lab">喜欢</span><em>{lib.length}</em>
              </button>
              <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
                <span className="dn-ico"><Fi n="list" size={14} /></span><span className="dn-lab">待播清单</span><em>{queue.list.length}</em>
              </button>
              <button className={tab === 'local' ? 'on' : ''} onClick={openLocal}>
                <span className="dn-ico"><Fi n="folder" size={14} /></span><span className="dn-lab">歌曲</span><em>{localTracks.length}</em>
              </button>
              <button className={tab === 'lyric' ? 'on' : ''} onClick={() => setTab('lyric')}>
                <span className="dn-ico"><Fi n="type" size={14} /></span><span className="dn-lab">歌词</span>
              </button>
            </nav>

            <div className="dn-scroll">
              <div className="dn-grp">
                <span>我的歌单</span>
                <button onClick={() => { setPlNew(true); setPlName('') }} title="新建歌单">＋</button>
              </div>
              {plNew && (
                <div className="dn-newpl">
                  <input autoFocus value={plName} placeholder="歌单名字"
                         onChange={(e) => setPlName(e.target.value)}
                         onKeyDown={(e) => {
                           if (e.key === 'Enter') createFromNew()
                           if (e.key === 'Escape') { setPlNew(false); setPlName('') }
                         }} />
                  <button onClick={createFromNew}>建</button>
                </div>
              )}
              {pls.map((p) => plRename?.id === p.id ? (
                <div key={p.id} className="dn-newpl">
                  <input autoFocus value={plRename.name} placeholder="歌单名字"
                         onChange={(e) => setPlRename({id: p.id, name: e.target.value})}
                         onKeyDown={(e) => {
                           if (e.key === 'Enter') commitRename()
                           if (e.key === 'Escape') setPlRename(null)
                         }} />
                  <button onClick={commitRename}>存</button>
                </div>
              ) : (
                <button key={p.id} className={'dn-pl' + (plSel === p.id ? ' on' : '')}
                        onClick={() => openPl(p.id)} title={p.name + '（双击名字可改名）'}>
                  <span className="dn-pl-cover">♪</span>
                  <span className="dn-pl-name"
                        onDoubleClick={(e) => { e.stopPropagation(); setPlRename({id: p.id, name: p.name}) }}>{p.name}</span>
                  <em>{p.tracks.length}</em>
                  <span className="dn-pl-ren" title="重命名这个歌单"
                        onClick={(e) => { e.stopPropagation(); setPlRename({id: p.id, name: p.name}) }}><Fi n="edit-2" size={11} /></span>
                  <span className={'dn-pl-del' + (plDel === p.id ? ' confirm' : '')}
                        onClick={(e) => { e.stopPropagation(); if (plDel === p.id) delPlaylist(p.id); else setPlDel(p.id) }}>
                    {plDel === p.id ? '删?' : <Fi n="trash-2" size={11} />}
                  </span>
                </button>
              ))}
              {!pls.length && <p className="dn-empty">点上面的 ＋ 建一个歌单，右侧「＋」把歌放进去</p>}

              <div className="dn-grp"><span>按专辑</span></div>
              <div className="dn-plist">
                {albums.map((a) => (
                  <button key={a.key} className={tab === 'library' && !plSel && libAlbum === a.key ? 'on' : ''}
                          onClick={() => openLib(a.key)} title={a.name}>
                    <span className="dn-pl-cover" style={a.cover ? {backgroundImage: `url("${a.cover}")`} : undefined}>
                      {a.cover ? '' : '♪'}
                    </span>
                    <span className="dn-pl-name">{a.name}</span>
                    <em>{a.n}</em>
                  </button>
                ))}
                {!albums.length && <p className="dn-empty">收藏几首歌，这里会自动按专辑分组</p>}
              </div>
            </div>

            <div className="dn-foot">
              <button title="插件" onClick={() => setTab('plugins')}><Fi n="package" size={14} /></button>
              <button title="设置" onClick={() => setTab('settings')}><Fi n="settings" size={14} /></button>
              <button className="dn-theme" onClick={() => pickTheme(NEXT_THEME[theme])} title={'主题：' + THEME_LABEL[theme]}>{THEME_ICON[theme]}</button>
            </div>
          </aside>

          <section className="desk-main">
            <div className="desk-top">
              <button className="dt-round" onClick={() => setTab('lyric')} title="歌词">
                <Fi n="music" size={16} />
              </button>
              <button className="dt-round" onClick={() => setTab('plugins')} title="插件">
                <Fi n="package" size={16} />
              </button>
              <div className="desk-search">
                <input value={q} placeholder="搜索音乐、歌手、专辑" onChange={(e) => setQ(e.target.value)}
                       onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
                <button onClick={doSearch} disabled={loading}>{loading ? '…' : '搜索'}</button>
              </div>
              <div className="desk-top-right">
                <button className="ghost-btn icon-only" onClick={() => pickTheme(NEXT_THEME[theme])} title={'主题：' + THEME_LABEL[theme]}>
                  <span className="dt-theme">{THEME_ICON[theme]}</span>
                </button>
                <button className="ghost-btn icon-only" onClick={() => toggleSkin(true)} title="皮肤界面 480×1024">
                  <Fi n="layout" size={14} />
                </button>
                <button className="ghost-btn icon-only" onClick={() => toggleMini(true)} title="小窗口模式">
                  <Fi n="minimize-2" size={14} />
                </button>
              </div>
            </div>

            <div className="desk-body">
              {tab === 'library' && (
                <div className="dpl-hero">
                  <div className="dpl-cover"
                       style={libView[0]?.cover ? {backgroundImage: `url("${libView[0].cover}")`} : undefined}>
                    {libView[0]?.cover ? '' : '♪'}
                  </div>
                  <div className="dpl-info">
                    <h2>{curPl ? curPl.name : (libAlbum || '我的收藏')}</h2>
                    <p>{curPl ? `自建歌单 · 共 ${libView.length} 首` : `千千静听 · 本地收藏 · 共 ${libView.length} 首`}</p>
                    <div className="dpl-btns">
                      <button className="dpl-main" disabled={!libView.length} onClick={() => play(libView[0])}>播放全部</button>
                      {!!curPl && (
                        <button className="dpl-sub" title="重命名这个歌单"
                                onClick={() => setPlRename({id: curPl.id, name: curPl.name})}>重命名</button>
                      )}
                      <button className="dpl-sub" disabled={!libView.length}
                              onClick={() => libView.forEach((t) => enqueue(t))}>批量加入待播</button>
                      <button className={'dpl-sub' + (selMode ? ' on' : '')}
                              onClick={() => { if (selMode) exitSel(); else { setSelMode(true); setSelIds([]) } }}>
                        {selMode ? '退出选择' : '选择'}
                      </button>
                    </div>
                    {selMode && (
                      <div className="dpl-bulk">
                        <span className="dpl-bulk-n">已选 {selIds.length} / {shown.length}</span>
                        <button onClick={selectAllShown}>全选</button>
                        <button onClick={() => { setSelIds([]); setBulkDel(false) }}>清空</button>
                        {!!plSel && (
                          <button className={'dpl-bulk-del' + (bulkDel ? ' on' : '')} disabled={!selIds.length}
                                  onClick={() => { if (bulkDel) removeSelFromPl(); else setBulkDel(true) }}>
                            {bulkDel ? '确认移出这 ' + selIds.length + ' 首' : '从歌单移出'}
                          </button>
                        )}
                        <button disabled={!selIds.length} onClick={bulkToQueue}>加入待播</button>
                        <button disabled={!selIds.length}
                                onClick={(e) => {
                                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                  setBulkPl({x: Math.max(8, Math.min(r.left - 150, window.innerWidth - 246)), y: r.bottom + 6})
                                }}>加入歌单</button>
                      </div>
                    )}
                    <div className="dpl-sort">
                      {!!curPl && (
                        <button className={plSort === 'manual' ? 'on' : ''} onClick={() => setSortMode('manual')}
                                title="按住行首的握把拖动，就能调整歌单里的顺序">拖动排序</button>
                      )}
                      <button className={plSort === 'time' ? 'on' : ''} onClick={() => setSortMode('time')}
                              title="自建歌单按加入时间，收藏库按收藏顺序">按时间</button>
                      <button className={plSort === 'name' ? 'on' : ''} onClick={() => setSortMode('name')}
                              title="按歌名的字面顺序">按名称</button>
                      <button className={plSort === 'pinyin' ? 'on' : ''} onClick={() => setSortMode('pinyin')}
                              title="中文按拼音 A–Z">按拼音</button>
                      <span className="dpl-sort-tip">
                        {plSort === 'manual'
                          ? (curPl ? '当前顺序就是歌单本身，拖完自动保存' : '收藏顺序由乐库决定')
                          : (plSort === 'name' ? '按字面排' : plSort === 'pinyin' ? '按拼音排' : '新加入的在前') +
                            '（只影响显示）'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {contentArea}
            </div>

            <footer className="desk-now">
              <div className="dnp-song">
                <div className={'dnp-cover' + (cur ? ' can-open' : '')}
                     onClick={() => { if (cur) setNpOpen(true) }}
                     title={cur ? '打开正在播放 (点击封面)' : ''}
                     style={cur?.cover ? {backgroundImage: `url("${cur.cover}")`} : undefined}>
                  {cur?.cover ? '' : <Fi n="music" size={18} />}
                </div>
                <div className="dnp-meta">
                  <b>{cur ? cur.name : '未在播放'}</b>
                  <em>{cur ? ([cur.artist, cur.album].filter(Boolean).join(' · ') || '—') : '选一首开始'}</em>
                </div>
                <button className={'dnp-heart' + (cur && lib.some((x) => x.id === cur.id) ? ' on' : '')}
                        onClick={() => { if (cur) fav(cur) }} title="收藏"><Fi n="heart" size={15} fill={!!(cur && lib.some((x) => x.id === cur.id))} /></button>
              </div>

              <div className="dnp-center">
                <div className="dnp-btns">
                  <button className={'dnp-ico' + (repeatOne ? ' on' : '')} onClick={() => setRepeatOne(!repeatOne)} title="单曲循环"><Fi n="repeat" size={15} /></button>
                  <button className="dnp-ico" onClick={() => step(-1)} title="上一首"><Fi n="skip-back" size={15} /></button>
                  <button className="dnp-play" onClick={toggle} title={playing ? '暂停' : '播放'}><Fi n={FN(playing ? 'pause' : 'play')} size={18} /></button>
                  <button className="dnp-ico" onClick={() => step(1)} title="下一首"><Fi n="skip-forward" size={15} /></button>
                  <div className="dnp-vol">
                    <Fi n={FN(volume > 0 ? 'volume-high' : 'volume-mute')} size={15} />
                    <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolumeState(Number(e.target.value))} />
                  </div>
                </div>
                <div className="dnp-prog">
                  <span>{fmt(pos)}</span>
                  <input type="range" min={0} max={Math.max(1, dur || 1)} value={Math.min(pos, dur || 1)}
                         onChange={(e) => {
                           const a = audio.current
                           const v = Number(e.target.value)
                           if (a) a.currentTime = v / 1000
                           setPos(v)
                         }} />
                  <span>{fmt(dur)}</span>
                </div>
              </div>

              <div className="dnp-right">
                <button onClick={() => setTab('lyric')} title="歌词界面"><Fi n="type" size={15} /></button>
                <button onClick={() => setTab('queue')} title="待播清单"><Fi n="list" size={15} /></button>
              </div>
            </footer>

                        {plMenu && (
                          <>
                            <div className="plmenu-mask" onClick={() => setPlMenu(null)} />
                            <div className="plmenu" style={{left: plMenu.x, top: plMenu.y}}>
                              <p className="plmenu-t">加入歌单</p>
                              {pls.map((pl) => {
                                const has = pl.tracks.some((x) => x.id === plMenu.t.id)
                                return (
                                  <button key={pl.id} className={has ? 'has' : ''}
                                          onClick={() => { addToPl(pl.id, plMenu.t); setPlMenu(null) }}>
                                    <span>{pl.name}</span>
                                    <em>{has ? '已加入' : pl.tracks.length}</em>
                                  </button>
                                )
                              })}
                              {!pls.length && <div className="plmenu-empty">还没有歌单</div>}
                              <button className="plmenu-new"
                                      onClick={() => { const id = newPlaylist('', plMenu.t); setPlMenu(null); setPlSel(id) }}>
                                ＋ 新建歌单并加入
                              </button>
                            </div>
                          </>
                        )}
                        {bulkPl && (
                          <>
                            <div className="plmenu-mask" onClick={() => setBulkPl(null)} />
                            <div className="plmenu" style={{left: bulkPl.x, top: bulkPl.y}}>
                              <p className="plmenu-t">把选中的 {selIds.length} 首加入</p>
                              {pls.map((pl) => (
                                <button key={pl.id} onClick={() => addSelToPl(pl.id)}>
                                  <span>{pl.name}</span>
                                  <em>{pl.tracks.length}</em>
                                </button>
                              ))}
                              {!pls.length && <div className="plmenu-empty">还没有歌单</div>}
                              <button className="plmenu-new"
                                      onClick={() => { setPlNewBulk(pickedSel()); setPlNew(true); setPlName(''); setBulkPl(null) }}>
                                ＋ 新建歌单并加入
                              </button>
                            </div>
                          </>
                        )}
          </section>
        </div>

      {mini && (
        <MiniPlayer
          cur={cur}
          lyricText={cur && Array.isArray(lyric) && lyric.length ? curLine : ''}
          playing={playing}
          busy={busy}
          inLib={!!cur && lib.some((x) => x.id === cur.id)}
          onToggle={toggle}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onExpand={() => toggleMini(false)}
          onClose={() => {
            // 迷你卡的 × 是真退出：Esc 才是还原窗口，两个不要混
            try { (window as any).go?.main?.App?.Quit?.() } catch { /* 忽略 */ }
          }}
          onFav={() => { if (cur) fav(cur) }}
          onQueue={() => { setTab('queue'); toggleMini(false) }}
          theme={theme}
          onTheme={() => pickTheme(NEXT_THEME[theme])}
        />
      )}

      {skin && (
        <SkinView
          cur={cur}
          playing={playing}
          busy={busy}
          pos={pos}
          dur={dur}
          lyric={lyric}
          curIndex={curIndex}
          queue={queue}
          volume={volume}
          eqGains={eqGains}
          inLib={!!cur && lib.some((x) => x.id === cur.id)}
          onToggle={toggle}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onSeek={(ms) => { const a = audio.current; if (a) a.currentTime = Math.max(0, ms / 1000) }}
          onVolume={(v) => setVolumeState(v)}
          onFav={() => { if (cur) fav(cur) }}
          onPlayAt={playAt}
          onExpand={() => toggleSkin(false)}
        />
      )}

      <audio
        ref={audio}
        crossOrigin="anonymous"
        onTimeUpdate={(e) => setPos((e.target as HTMLAudioElement).currentTime * 1000)}
        onDurationChange={(e) => {
          const d = (e.target as HTMLAudioElement).duration
          setDur(isFinite(d) ? d * 1000 : 0)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        onError={() => { setErr('这条音频播不了（可能是 VIP 曲、无版权）'); setPlaying(false) }}
      />

      {npOpen && (
        <NowPlaying
          cur={cur}
          playing={playing}
          pos={pos}
          dur={dur}
          lyric={lyric}
          curIndex={curIndex}
          busy={busy}
          volume={volume}
          inLib={!!cur && lib.some((x) => x.id === cur.id)}
          shuffle={shuffle}
          repeat={repeatOne}
          errText={err}
          onClose={() => setNpOpen(false)}
          onToggle={toggle}
          onSeek={(ms) => {
            const a = audio.current
            if (!a) return
            a.currentTime = Math.max(0, ms / 1000)
            setPos(ms)
          }}
          onVolume={setVolumeState}
          onFav={() => { if (cur) fav(cur) }}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          queue={queue.list}
          queueIdx={queue.idx}
          onPlayAt={playAt}
          onRemove={queueRemove}
          onShuffle={() => setShuffle(!shuffle)}
          onRepeat={() => setRepeatOne(!repeatOne)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {signInReq && <SignInModal req={signInReq} onClose={() => setSignInReq(null)} />}
    </div>
  )
}
