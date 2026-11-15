/* MusicFree 插件运行时。

   MusicFree 的插件是单个 .js，用 CommonJS 写：
     const axios = require('axios')
     module.exports = { platform, version, search, getMediaSource, getLyric, … }

   它和 MyGo 插件是两套规范，但对外要长成同一个样子，所以这里做两件事：
   1. 造一个 require 垫片：axios 走后端 HttpRequest（和 MyGo 插件同一套绕 CORS 的路），
      cheerio / crypto-js / he / qs / lodash 这类纯 JS 库从 CDN 拉 ESM 版本；
   2. 把 MusicFree 的三件套（search / getMediaSource / getLyric）适配成
      pluginRuntime 期望的返回形状，这样搜索、播放、歌词链路一行都不用改。

   插件代码本身在 WebView 里执行，能拿到 window，但拿不到后端 Go 方法之外的东西。 */

import {bridge} from './pluginRuntime'

type AnyObj = Record<string, any>

const moduleCache = new Map<string, AnyObj>()
const sourceCache = new Map<string, string>()
const pkgCache = new Map<string, any>()

const CDN = 'https://esm.sh/'

/** 第三方库按需从 CDN 取 ESM 版本，取到就缓存。 */
async function loadPkg(name: string): Promise<any> {
  if (pkgCache.has(name)) return pkgCache.get(name)
  const aliases: Record<string, string> = {
    cheerio: 'cheerio@1.0.0-rc.12',
    'crypto-js': 'crypto-js@4.2.0',
    he: 'he@1.2.0',
    qs: 'qs@6.11.2',
    lodash: 'lodash@4.17.21',
    dayjs: 'dayjs@1.11.10',
    'big.js': 'big.js@6.2.1',
    'isomorphic-fetch': 'node-fetch@2',
  }
  const spec = aliases[name] || name
  const m: any = await import(/* @vite-ignore */ CDN + spec)
  const v = m?.default ?? m
  pkgCache.set(name, v)
  return v
}

/** axios 垫片：字段对齐 MusicFree 插件里最常见的用法（get/post/request/create/defaults）。 */
function makeAxios(): AnyObj {
  const joinParams = (target: string, params?: AnyObj) => {
    if (!params) return target
    const parts: string[] = []
    Object.keys(params).forEach((k) => {
      const v = params[k]
      if (v == null) return
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v)))
    })
    if (!parts.length) return target
    return target + (target.indexOf('?') >= 0 ? '&' : '?') + parts.join('&')
  }

  const request = async (cfg: AnyObj): Promise<AnyObj> => {
    const app: any = bridge()
    if (!app?.HttpRequest) throw new Error('网络能力不可用')
    const method = String(cfg.method || 'GET').toUpperCase()
    let target = String(cfg.url || cfg.uri || '')
    if (cfg.baseURL && !/^https?:/.test(target)) target = String(cfg.baseURL).replace(/\/$/, '') + '/' + target.replace(/^\//, '')
    target = joinParams(target, cfg.params)

    const headers: AnyObj = {}
    if (cfg.headers) Object.keys(cfg.headers).forEach((k) => { if (cfg.headers[k] != null) headers[k] = String(cfg.headers[k]) })

    let body = ''
    const data = cfg.data
    if (data != null && method !== 'GET' && method !== 'HEAD') {
      if (typeof data === 'string') body = data
      else {
        body = JSON.stringify(data)
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
      }
    }

    const r: any = await app.HttpRequest(target, method, headers, body, false)
    if (r?.err) throw new Error(String(r.err))
    const status = Number(r?.status) || 0
    if (status >= 400) {
      const e: any = new Error('HTTP ' + status)
      e.response = {status, data: r?.body, headers: r?.headers || {}}
      throw e
    }

    let out: any = r?.body ?? ''
    const type = String(cfg.responseType || '')
    if (type === 'arraybuffer' || type === 'blob') {
      // 后端把二进制以 base64 回传，这里还原成 ArrayBuffer 给插件自己解
      const b64: string = r?.bodyB64 || ''
      const bin = atob(b64)
      const buf = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
      out = buf.buffer
    } else if (type !== 'text') {
      const t = String(out || '').trim()
      if (type === 'json' || (t && (t[0] === '{' || t[0] === '['))) {
        try { out = JSON.parse(t) } catch { /* 保留原文 */ }
      }
    }
    return {data: out, status, statusText: String(status), headers: r?.headers || {}, config: cfg}
  }

  const inst: AnyObj = {
    request,
    get: (url: string, cfg: AnyObj = {}) => request({...cfg, url, method: 'GET'}),
    post: (url: string, data?: any, cfg: AnyObj = {}) => request({...cfg, url, method: 'POST', data}),
    put: (url: string, data?: any, cfg: AnyObj = {}) => request({...cfg, url, method: 'PUT', data}),
    delete: (url: string, cfg: AnyObj = {}) => request({...cfg, url, method: 'DELETE'}),
    head: (url: string, cfg: AnyObj = {}) => request({...cfg, url, method: 'HEAD'}),
    defaults: {headers: {common: {}}},
    create: (cfg: AnyObj = {}) => makeAxiosWith(cfg),
    interceptors: {request: {use: () => 0}, response: {use: () => 0}},
    CancelToken: {source: () => ({token: {}, cancel: () => {}})},
    isCancel: () => false,
  }
  inst.default = inst
  return inst
}

/** axios.create() 的简化版：只把 baseURL / headers 带上。 */
function makeAxiosWith(cfg: AnyObj): AnyObj {
  const base: AnyObj = {...cfg}
  const req = async (c: AnyObj) => {
    const merged = {...base, ...c, headers: {...(base.headers || {}), ...(c.headers || {})}}
    const ax = makeAxios()
    return (ax as any).request(merged)
  }
  const inst: AnyObj = {
    request: req,
    get: (url: string, c: AnyObj = {}) => req({...c, url, method: 'GET'}),
    post: (url: string, data?: any, c: AnyObj = {}) => req({...c, url, method: 'POST', data}),
    defaults: {headers: {common: {}}},
    interceptors: {request: {use: () => 0}, response: {use: () => 0}},
  }
  inst.default = inst
  return inst
}

/** require 垫片。
 *
 * 坑点：插件里是同步 require，而 CDN 取包是异步的。所以不能等插件执行到那一行
 * 才去拉 —— 必须先扫一遍源码里的 require('xxx')，把需要的包全部 await 回来，
 * 再同步交给插件。
 */
async function makeRequire(code: string): Promise<(name: string) => any> {
  const names = new Set<string>()
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) names.add(String(m[1]).replace(/^node:/, ''))

  // 先加载所有能在 CDN 上找到的
  for (const name of names) {
    if (name === 'axios') continue
    try {
      await loadPkg(name)
    } catch {
      /* 拿不到就等 require 时报错，提示缺哪个包 */
    }
  }

  const cryptoStub = {
    createHash: () => ({update: () => ({digest: () => ''})}),
    createHmac: () => ({update: () => ({digest: () => ''})}),
    randomBytes: (n: number) => new Uint8Array(n),
    randomUUID: () => String(Math.random()).slice(2),
  }

  return (name: string) => {
    const key = String(name || '').replace(/^node:/, '')
    if (key === 'axios') return makeAxios()
    if (key === 'crypto') return cryptoStub
    if (key === 'url') return {URL: URL, URLSearchParams: URLSearchParams}
    if (key === 'buffer') return {Buffer: {from: (x: any) => x, isBuffer: () => false}}
    if (pkgCache.has(key)) return pkgCache.get(key)
    throw new Error('MusicFree 插件依赖了桌面版没能加载的包：' + name + '（目前内置 axios，CDN 可取 cheerio / crypto-js / he / qs / lodash / dayjs / big.js）')
  }
}

/** 执行插件源码，返回 module.exports。同一个插件只执行一次。 */
export async function loadMusicFree(pluginId: string): Promise<AnyObj> {
  if (moduleCache.has(pluginId)) return moduleCache.get(pluginId)!
  const app: any = bridge()
  if (!app?.PluginSource) throw new Error('插件能力不可用')
  let code = sourceCache.get(pluginId)
  if (!code) {
    const raw: any = await app.PluginSource(pluginId)
    code = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw[0] : '')
    if (!code || !String(code).trim()) throw new Error('读不到插件源码：' + pluginId)
    sourceCache.set(pluginId, String(code))
  }
  const requireFn = await makeRequire(String(code))
  const mod: AnyObj = {exports: {}}
  const fn = new Function(
    'module', 'exports', 'require', 'console', '__filename',
    String(code) + '\n//# sourceURL=hulu-mf-' + pluginId + '.js'
  )
  fn(mod, mod.exports, requireFn, console, pluginId + '.js')
  const exp = mod.exports
  if (!exp || typeof exp !== 'object' && typeof exp !== 'function') {
    throw new Error('插件没有导出任何东西（要 module.exports = { … }）')
  }
  moduleCache.set(pluginId, exp)
  return exp
}

export function clearMusicFreeCache(pluginId?: string) {
  if (pluginId) {
    moduleCache.delete(pluginId)
    sourceCache.delete(pluginId)
    return
  }
  moduleCache.clear()
  sourceCache.clear()
}

/* ---------- 适配成 pluginRuntime 的三件套 ---------- */

const str = (v: any) => (v == null ? '' : String(v))

/** MusicFree 的 search 返回 {isEnd, data:[…]}，这里映射成插件曲目项。 */
export async function mfSearch(pluginId: string, keyword: string, page = 1): Promise<AnyObj[]> {
  const mod = await loadMusicFree(pluginId)
  if (typeof mod.search !== 'function') throw new Error('这个 MusicFree 插件没有 search 方法')
  const res: any = await mod.search(keyword, page)
  const list: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  const out: AnyObj[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    out.push({
      // 原始 item 原样保留：getMediaSource / getLyric 要拿它回去
      ...it,
      title: str(it.title || it.name || it.songname),
      artist: str(it.artist || it.singer || it.artists),
      album: str(it.album || it.albumName),
      artwork: str(it.artwork || it.cover || it.pic || it.img),
      duration: Number(it.duration || it.interval || 0) || 0,
      id: str(it.id || it.songmid || it.songId || it.songid || ''),
    })
  }
  return out
}

/** 取播放地址：MusicFree 可能返回字符串、{url}、{url,headers} 或数组。 */
export async function mfMediaSource(pluginId: string, item: AnyObj, quality = 'standard'): Promise<{url: string; referer: string}> {
  const mod = await loadMusicFree(pluginId)
  if (typeof mod.getMediaSource !== 'function') throw new Error('这个 MusicFree 插件没有 getMediaSource 方法')
  let res: any = await mod.getMediaSource(item, quality)
  if (Array.isArray(res)) {
    // 多码率：优先选 quality 命中的，否则第一个
    const picked = res.find((x: any) => str(x?.quality).toLowerCase() === String(quality).toLowerCase()) || res[0]
    res = picked
  }
  if (typeof res === 'string') return {url: res, referer: ''}
  const url = str(res?.url || res?.src)
  if (!url) throw new Error('插件没有给出可用的播放地址（可能需要登录或该曲无版权）')
  const headers = res?.headers || {}
  const referer = str(headers.Referer || headers.referer || headers['referer'] || '')
  return {url, referer}
}

function parseLrc(raw: string): {time: number; text: string}[] {
  const out: {time: number; text: string}[] = []
  for (const line of String(raw || '').split('\n')) {
    const m = line.trim().match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/)
    if (!m) continue
    const text = m[3].trim()
    if (!text) continue
    out.push({time: Number(m[1]) * 60 * 1000 + Math.round(Number(m[2]) * 1000), text})
  }
  return out
}

/** 歌词：getLyric 通常返回 {rawLrc} 或 {lrc}。 */
export async function mfLyric(pluginId: string, item: AnyObj): Promise<{time: number; text: string}[]> {
  const mod = await loadMusicFree(pluginId)
  if (typeof mod.getLyric !== 'function') return []
  const res: any = await mod.getLyric(item)
  const raw = str(res?.rawLrc || res?.lrc || res?.lyric || (typeof res === 'string' ? res : ''))
  return parseLrc(raw)
}
