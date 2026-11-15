import { useEffect, useState } from 'react'
import {type Theme} from './theme'

type Settings = {
  theme: string
  volume: number
  autoPlay: boolean
  showLyric: boolean
  defaultTab: string
  sources: string[]
  searchLimit: number
  proxyPort: number
  dataDir: string
  version: string
}

type AccountItem = {id: string; name: string; who: string}

type Props = {
  theme: Theme
  onTheme: (t: Theme) => void
  accounts: AccountItem[]
  onSignOut: (id: string) => void
  onRefreshAccounts: () => void
}

const bridge = () => (window as any).go?.main?.App

async function callM<T>(fn: string, ...args: any[]): Promise<T> {
  const app = bridge()
  if (!app || typeof app[fn] !== 'function') throw new Error('后端未就绪')
  return await app[fn](...args)
}

const empty: Settings = {
  theme: 'dark',
  volume: 0.8,
  autoPlay: true,
  showLyric: true,
  defaultTab: 'search',
  sources: ['ne', 'qq'],
  searchLimit: 20,
  proxyPort: 0,
  dataDir: '',
  version: '',
}

export default function SettingsPage({ theme, onTheme, accounts, onSignOut, onRefreshAccounts }: Props) {
  const [s, setS] = useState<Settings>(empty)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [activePlugins, setActivePlugins] = useState<any[]>([])

  async function openHome(url: string) {
    try {
      const r = await callM<string>('OpenExternal', url)
      if (r) setErr(r)
    } catch {
      // 浏览器预览没有这个桥接方法，退回新标签页打开
      window.open(url, '_blank', 'noopener')
    }
  }

  async function reload() {
    setLoading(true)
    try {
      const r = await callM<Settings>('GetSettings')
      if (r) setS({ ...empty, ...r })
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    callM<any>('Plugins')
      .then((raw: any) => {
        const list = Array.isArray(raw) ? raw : []
        setActivePlugins(list.filter((p: any) => p.enabled))
      })
      .catch(() => {})
  }, [])

  function patch(p: Partial<Settings>) {
    setS((old) => ({ ...old, ...p }))
  }

  async function save() {
    setErr('')
    setMsg('')
    try {
      const payload: Settings = { ...s, theme }
      const raw: any = await callM<any>('SaveSettings', payload)
      // 双返回值被 Wails 合并成单值：成功给 Settings，失败给错误字符串
      if (typeof raw === 'string') {
        setErr(raw)
        return
      }
      if (raw) setS({ ...empty, ...raw })
      setMsg('已保存')
      setTimeout(() => setMsg(''), 2000)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  async function reset() {
    try {
      const raw: any = await callM<any>('ResetSettings')
      if (typeof raw === 'string') {
        setErr(raw)
        return
      }
      if (raw) setS({ ...empty, ...raw })
      setMsg('已恢复默认')
      setTimeout(() => setMsg(''), 2000)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  async function openDir() {
    try {
      const raw: any = await callM<any>('OpenDataDir')
      if (typeof raw === 'string' && raw.trim() && !/^\//.test(raw) && !/^[C-Z]:\\/.test(raw) && raw.length > 3) {
        // 返回的是错误信息
        setErr(raw)
      }
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  async function clearLib() {
    if (!window.confirm('确定清空「我的收藏」吗？这个操作不可撤销。')) return
    try {
      await callM('ClearLibrary')
      setMsg('收藏已清空')
      setTimeout(() => setMsg(''), 2000)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  return (
    <div className="set-page">
      <section className="set-card">
        <h3>账号</h3>
        <p className="set-hint">插件扫码登录后的账号在这里管理。搜索时插件报未登录，会在搜索结果页弹出对应的扫码入口。</p>
        {accounts.length === 0 ? (
          <div className="acct-empty">还没有登录的账号。</div>
        ) : (
          <div className="acct-list">
            {accounts.map((a) => (
              <div key={a.id} className="acct-row">
                <div className="acct-main">
                  <b>{a.name}</b>
                  <em>{a.who}</em>
                </div>
                <button className="ghost-btn danger" onClick={() => onSignOut(a.id)}>登出</button>
              </div>
            ))}
          </div>
        )}
        <div className="set-row">
          <label>　</label>
          <button className="ghost-btn" onClick={onRefreshAccounts}>重新读取账号</button>
        </div>
      </section>

      <section className="set-card">
        <h3>内容平台主页</h3>
        <p className="set-hint">点「打开主页」会用系统默认浏览器打开对应平台官网，登录、收藏、听书都在网页里操作。</p>
        <div className="set-row">
          <label>喜马拉雅</label>
          <div className="home-row">
            <span className="home-url">www.ximalaya.com</span>
            <button className="ghost-btn" onClick={() => openHome('https://www.ximalaya.com')}>打开主页</button>
          </div>
        </div>
        <div className="set-row">
          <label>QQ 音乐听书</label>
          <div className="home-row">
            <span className="home-url">y.qq.com/musicroom/voice</span>
            <button className="ghost-btn" onClick={() => openHome('https://y.qq.com/wk_v17/#/musicroom/voice')}>打开主页</button>
          </div>
        </div>
        <div className="set-row">
          <label>　</label>
          <div className="home-row">
            <span className="home-url">听书频道分类</span>
            <button className="ghost-btn" onClick={() => openHome('https://c.y.qq.com/node/pc/wk_v15/audio.html')}>有声节目页</button>
          </div>
        </div>
      </section>

      <section className="set-card">
        <h3>外观</h3>
        <div className="set-row">
          <label>主题</label>
          <div className="seg">
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => onTheme('dark')}>深色</button>
            <button className={theme === 'light' ? 'on' : ''} onClick={() => onTheme('light')}>浅色</button>
            <button className={theme === 'amber' ? 'on' : ''} onClick={() => onTheme('amber')}>橘黄</button>
          </div>
        </div>
        <div className="set-row">
          <label>启动页</label>
          <select
            value={['search', 'radio', 'podcast', 'library', 'local'].includes(s.defaultTab) ? s.defaultTab : 'search'}
            onChange={(e) => patch({ defaultTab: e.target.value })}
          >
            <option value="search">搜索结果</option>
            <option value="radio">电台</option>
            <option value="podcast">听书</option>
            <option value="library">我的收藏</option>
            <option value="local">乐库</option>
          </select>
        </div>
      </section>

      <section className="set-card">
        <h3>播放</h3>
        <div className="set-row">
          <label>默认音量</label>
          <div className="range-row">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(s.volume * 100)}
              onChange={(e) => patch({ volume: Number(e.target.value) / 100 })}
            />
            <span className="val">{Math.round(s.volume * 100)}%</span>
          </div>
        </div>
        <div className="set-row">
          <label>选中即播放</label>
          <button className={'switch' + (s.autoPlay ? ' on' : '')} onClick={() => patch({ autoPlay: !s.autoPlay })}>
            <i />
          </button>
        </div>
        <div className="set-row">
          <label>播放条显示歌词</label>
          <button className={'switch' + (s.showLyric ? ' on' : '')} onClick={() => patch({ showLyric: !s.showLyric })}>
            <i />
          </button>
        </div>
      </section>

      <section className="set-card">
        <h3>搜索</h3>
        <div className="set-row">
          <label>音源</label>
          <div className="chips">
            {activePlugins.length === 0 && <span className="mono">没有启用的插件</span>}
            {activePlugins.map((p) => (
              <span className="chip on" key={p.id}>{p.name}</span>
            ))}
          </div>
        </div>
        <div className="set-row">
          <label>说明</label>
          <span className="mono">音源全部由插件提供，去「插件」页安装 / 启用</span>
        </div>
        <div className="set-row">
          <label>每源条数</label>
          <input
            className="num"
            type="number"
            min={5}
            max={100}
            value={s.searchLimit}
            onChange={(e) => patch({ searchLimit: Number(e.target.value) })}
          />
        </div>
      </section>

      <section className="set-card">
        <h3>运行时</h3>
        <div className="set-row">
          <label>版本</label>
          <span className="mono">{s.version || '—'}</span>
        </div>
        <div className="set-row">
          <label>本地代理</label>
          <span className="mono">{s.proxyPort ? '127.0.0.1:' + s.proxyPort : '未启动'}</span>
        </div>
        <div className="set-row">
          <label>数据目录</label>
          <div className="dir-row">
            <span className="mono ellipsis" title={s.dataDir}>{s.dataDir}</span>
            <button className="mini-btn" onClick={openDir}>打开</button>
          </div>
        </div>
      </section>

      <section className="set-card">
        <h3>数据</h3>
        <div className="set-row">
          <label>清空收藏</label>
          <button className="danger-btn" onClick={clearLib}>清空</button>
        </div>
      </section>

      <div className="set-actions">
        <button className="primary-btn" onClick={save} disabled={loading}>{loading ? '读取中…' : '保存设置'}</button>
        <button className="ghost-btn" onClick={reset}>恢复默认</button>
        {msg && <span className="ok-msg">{msg}</span>}
        {err && <span className="err-msg">{err}</span>}
      </div>
    </div>
  )
}
