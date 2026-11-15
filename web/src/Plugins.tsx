import { useEffect, useState } from 'react'
import {
  clearPluginCache,
  encodePluginTrack,
  pluginSearch,
  type PluginSearchItem,
} from './pluginRuntime'
import {getPluginSettingCache, mygoAccount, mygoCapabilities, mygoSignIn, mygoSignOut, setPluginSettingCache} from './mygoRuntime'

type Plugin = {
  id: string
  name: string
  version: string
  author: string
  homepage: string
  description: string
  enabled: boolean
  compatible: boolean
  size: number
  installedAt: string
  file: string
  kind?: string
  actions?: string[]
}

type Track = { id: string; name: string; artist: string; album: string; cover: string; duration: number; source: string }

const bridge = () => (window as any).go?.main?.App

async function callM<T>(fn: string, ...args: any[]): Promise<T> {
  const app = bridge()
  if (!app || typeof app[fn] !== 'function') throw new Error('后端未就绪')
  return await app[fn](...args)
}

// Wails 会把 (数据, 错误) 两个返回值打包成 [数据, 错误] 传过来；
// 不拆包就会出现「提示装好了、列表其实是空的」这种假成功。
async function callList(fn: string, ...args: any[]): Promise<{ list: Plugin[]; err: string }> {
  const raw: any = await callM<any>(fn, ...args)
  if (Array.isArray(raw)) {
    if (raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'string') {
      return { list: raw[0] as Plugin[], err: raw[1] }
    }
    return { list: raw as Plugin[], err: '' }
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).plugins)) {
    const r = raw as any
    return { list: r.plugins as Plugin[], err: String(r.err || ''), }
  }
  if (typeof raw === 'string' && raw.trim()) return { list: [], err: raw }
  return { list: [], err: '' }
}

const fmtSize = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')

export default function PluginsPage({ onPlay }: { onPlay: (t: Track) => void }) {
  const [list, setList] = useState<Plugin[]>([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  // 插件试搜
  const [sel, setSel] = useState('')
  const [kw, setKw] = useState('')
  const [hits, setHits] = useState<PluginSearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const [testErr, setTestErr] = useState('')
  // 插件详情：plugin.json 里的 settings 声明 + 登录态
  const [manifest, setManifest] = useState<any>(null)
  const [setVals, setSetVals] = useState<Record<string, string>>({})
  const [account, setAccount] = useState<any>(null)
  const [caps, setCaps] = useState<{signIn: boolean; account: boolean}>({signIn: false, account: false})
  const [accBusy, setAccBusy] = useState(false)
  // 登录自己的报错：只显示在账号卡片里，不跟试搜的错误混在一起
  const [accErr, setAccErr] = useState('')

  async function reload() {
    try {
      const r = await callList('Plugins')
      setList(r.list)
      if (r.err) setErr(r.err)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  useEffect(() => {
    reload()
    // 把 .zip / 插件文件夹直接拖进窗口，后端会当场装好，装完发这个事件
    // 让列表重新拉一遍（不依赖系统文件对话框）。
    const h = () => reload()
    window.addEventListener('hulu-plugin-installed', h)
    return () => window.removeEventListener('hulu-plugin-installed', h)
  }, [])

  function flash(t: string) {
    setMsg(t)
    setTimeout(() => setMsg(''), 2500)
  }

  async function installURL() {
    if (!url.trim() || busy) return
    setBusy(true); setErr('')
    try {
      const raw: any = await callM<any>('InstallPluginURL', url.trim())
      const r = Array.isArray(raw) ? {plugins: raw[0], err: raw[1]} : raw || {}
      if (Array.isArray(r.plugins)) setList(r.plugins)
      if (r.err) setErr(String(r.err))
      else { flash('插件已安装'); setUrl('') }
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function installText() {
  }

  // 本地安装：直接弹系统的文件/文件夹对话框，不用手输路径
  async function pickLocal(kind: 'zip' | 'dir') {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const r: any = await callM<any>(kind === 'zip' ? 'PickPluginZip' : 'PickPluginDir')
      if (r?.canceled) return
      if (Array.isArray(r?.plugins)) setList(r.plugins)
      if (r?.err) { setErr(String(r.err)); return }
      if (r?.installedId) setSel(r.installedId)
      flash('插件已安装')
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function toggle(p: Plugin) {
    try {
      const r = await callList('SetPluginEnabled', p.id, !p.enabled)
      setList(r.list)
      if (r.err) setErr(r.err)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  async function remove(p: Plugin) {
    if (!window.confirm('删除插件「' + p.name + '」？')) return
    try {
      const r = await callList('RemovePlugin', p.id)
      setList(r.list)
      clearPluginCache(p.id)
      if (r.err) setErr(r.err)
      else flash('已删除')
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  // 读插件自己的 plugin.json：设置项声明、是否支持登录
  async function loadDetail(id: string) {
    setManifest(null); setAccount(null)
    const app: any = (window as any).go?.main?.App
    if (!app?.PluginFile) return
    try {
      const raw = await app.PluginFile(id, 'plugin.json')
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : ''
      const m = text ? JSON.parse(text) : null
      setManifest(m)
    } catch {
      setManifest(null)
    }
    try {
      setSetVals(getPluginSettingCache(id))
      if (app.PluginSettings) {
        const r = await app.PluginSettings(id)
        const v = Array.isArray(r) ? r[0] : r
        if (v && typeof v === 'object') {
          setSetVals({...v})
          setPluginSettingCache(id, v)
        }
      }
    } catch { /* 设置读不到就留空 */ }
    try {
      setCaps(await mygoCapabilities(id))
    } catch {
      setCaps({signIn: false, account: false})
    }
    try {
      setAccount(await mygoAccount(id))
    } catch {
      setAccount(null)
    }
  }

  async function saveSetting(key: string) {
    const app: any = (window as any).go?.main?.App
    if (!app?.SavePluginSetting || !sel) return
    try {
      const r = await app.SavePluginSetting(sel, key, setVals[key] ?? '')
      const v = Array.isArray(r) ? r[0] : r
      if (v && typeof v === 'object') {
        setSetVals({...v})
        setPluginSettingCache(sel, v)
      }
      // 插件下次调用会重新读设置，清掉已加载的实例
      clearPluginCache(sel)
      flash('设置已保存')
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  async function doSignIn() {
    if (!sel || accBusy) return
    setAccBusy(true); setAccErr('')
    try {
      const who = await mygoSignIn(sel)
      setAccount(who || null)
      flash('已登录')
    } catch (e: any) {
      const msg = String(e?.message || e || '登录失败')
      setAccErr(msg)
      setTestErr(msg)
    } finally {
      setAccBusy(false)
    }
  }

  async function doSignOut() {
    if (!sel || accBusy) return
    setAccBusy(true); setTestErr('')
    try {
      const who = await mygoSignOut(sel)
      setAccount(null)
      flash(who.name ? '已登出 ' + who.name : '已登出')
    } catch (e: any) {
      setTestErr(String(e?.message || e))
    } finally {
      setAccBusy(false)
    }
  }

  async function test(p: Plugin) {
    void loadDetail(p.id)
    setSel(p.id); setHits([]); setTestErr('')
    if (!p.enabled) setTestErr('这个插件当前是关闭状态，先启用再试')
    else if (p.compatible === false) {
      setTestErr('这个插件读不出可执行的导出：MyGo 插件要有 plugin.json 和 index.js（ESM 导出）。检查一下目录是否完整。')
    }
  }

  async function doSearch() {
    if (!sel || !kw.trim() || searching) return
    setSearching(true); setTestErr(''); setHits([])
    try {
      const res = await pluginSearch(sel, kw.trim(), 1)
      setHits(res)
      if (res.length === 0) setTestErr('插件没有返回结果')
    } catch (e: any) {
      setTestErr(String(e?.message || e))
    } finally {
      setSearching(false)
    }
  }

  async function playHit(it: PluginSearchItem) {
    const name = it.title || '未命名'
    const artist = it.artist || ''
    const cover = it.artwork || ''
    // 真正的取流在播放时做（走 MyGo 运行时），这里不再预加载
    onPlay({
      id: encodePluginTrack(sel, it as any),
      name,
      artist,
      album: it.album || ('插件 · ' + (list.find((p) => p.id === sel)?.name || sel)),
      cover,
      duration: Number(it.duration) || 0,
      source: 'plugin',
    })
  }

  const current = list.find((p) => p.id === sel)
  // 只有插件真的导出了 signIn 才给登录入口：先看后端探测的 actions，
  // 再以模块实际导出为准（两者任一为真就给，点了没实现会报明确错误）
  const canSignIn = !!current && (!!current.actions?.includes('signIn') || caps.signIn)

  return (
    <div className="plug-page">
      <section className="set-card">
        <h3>安装插件</h3>
        <p className="hint">
          只支持 MyGo Music 规范：一个插件目录，里面有 <code>plugin.json</code> 和 <code>index.js</code>
          （ESM 导出 search / stream / lyrics，用全局 <code>host</code> 和 <code>fetch</code>）。
          「选 zip」直接挑打包好的插件压缩包，「选文件夹」直接挑插件目录（例如 QQ 插件仓库里的 <code>dist</code>）；
          也可以在上面填 .zip 的下载地址；<b>或者干脆把 .zip / 插件文件夹直接拖进窗口</b>，拖进来就装好了。
        </p>
        <div className="plug-install">
          <input
            value={url}
            placeholder="https://example.com/plugin.zip"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && installURL()}
          />
          <button className="primary-btn" onClick={installURL} disabled={busy}>{busy ? '…' : '安装'}</button>
          <button className="ghost-btn" onClick={() => pickLocal('zip')}>选 zip</button>
          <button className="ghost-btn" onClick={() => pickLocal('dir')}>选文件夹</button>
        </div>
        {msg && <div className="ok-msg">{msg}</div>}
        {err && <div className="err-msg">{err}</div>}
      </section>

      <section className="set-card">
        <h3>已安装 <span className="cnt">{list.length}</span></h3>
        {list.length === 0 && <div className="empty small">还没有插件。装一个之后这里会出现开关和试搜入口。</div>}
        <div className="plug-list">
          {list.map((p) => (
            <div className={'plug-item' + (sel === p.id ? ' sel' : '')} key={p.id}>
              <div className="plug-main">
                <div className="plug-name">
                  {p.name}
                  <span className="plug-ver">v{p.version}</span>
                  {!p.compatible && <span className="plug-off" title="读不出可执行导出">不兼容</span>}
                  {!p.enabled && <span className="plug-off">已关闭</span>}
                </div>
                <div className="plug-sub">
                  {p.author ? '作者 ' + p.author + ' · ' : ''}
                  {fmtSize(p.size)} · {p.installedAt}
                  {p.description ? ' · ' + p.description : ''}
                </div>
              </div>
              <div className="plug-ops">
                <button className="mini-btn" onClick={() => test(p)}>试搜</button>
                <button className={'switch' + (p.enabled ? ' on' : '')} onClick={() => toggle(p)} title="启用 / 关闭">
                  <i />
                </button>
                <button className="danger-mini" onClick={() => remove(p)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {current && (
        <section className="set-card">
          <h3>试搜 · {current.name}</h3>
          <div className="plug-test">
            <input
              value={kw}
              placeholder="输入关键词，比如 晴天"
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button className="primary-btn" onClick={doSearch} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
          </div>
          {testErr && <div className="err-msg">{testErr}</div>}
          <div className="list">
            {hits.map((it, i) => (
              <div className="row" key={i}>
                <button className="idx" onClick={() => playHit(it)}>▶</button>
                <div
                  className="cover"
                  style={it.artwork ? { backgroundImage: 'url(' + it.artwork + ')' } : undefined}
                />
                <div className="info">
                  <div className="name">{it.title || '未命名'}</div>
                  <div className="sub">{it.artist || '—'}{it.album ? ' · ' + it.album : ''}</div>
                </div>
                <span className="tag">插件</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {current && (manifest?.settings?.length || manifest?.settings) ? (
        <section className="set-card">
          <h3>设置 · {current.name}</h3>
          <p className="hint">这些是插件自己在 plugin.json 里声明的设置项，存在本地，插件下次调用时生效。</p>
          <div className="plug-settings">
            {(Array.isArray(manifest.settings) ? manifest.settings : []).map((it: any) => (
              <label className="set-row" key={it.key}>
                <span className="set-label">{it.label || it.key}</span>
                <input
                  value={setVals[it.key] ?? ''}
                  placeholder={it.key}
                  onChange={(e) => setSetVals({...setVals, [it.key]: e.target.value})}
                  onBlur={() => saveSetting(it.key)}
                />
                {it.help ? <em className="set-help">{it.help}</em> : null}
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {current && canSignIn && account !== null ? (
        <section className="set-card">
          <h3>账号 · {current.name}</h3>
          <div className="acct">
            {account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <i className="acct-ico" />}
            <div>
              <b>{account?.name || account?.nickname || '已登录'}</b>
              <em>{account?.id ? 'ID ' + account.id : ''}{account?.vip ? ' · ' + account.vip : ''}</em>
            </div>
            <div className="acct-ops">
              <button className="ghost-btn" onClick={doSignIn} disabled={accBusy}>{accBusy ? '…' : '重新登录'}</button>
              <button className="ghost-btn danger" onClick={doSignOut} disabled={accBusy}>{accBusy ? '…' : '登出'}</button>
            </div>
          </div>
        </section>
      ) : current && canSignIn ? (
        <section className="set-card">
          <h3>账号 · {current.name}</h3>
          <div className="acct">
            <div>
              <b>未登录</b>
              <em>这个插件要登录才能取流</em>
            </div>
            <button className="primary-btn" onClick={doSignIn} disabled={accBusy}>{accBusy ? '等待扫码…' : '扫码登录'}</button>
          </div>
          {accBusy ? <p className="acct-hint">正在向插件要二维码，二维码窗口稍后弹出…</p> : null}
          {accErr ? <p className="acct-err">{accErr}</p> : null}
        </section>
      ) : null}
    </div>
  )
}
