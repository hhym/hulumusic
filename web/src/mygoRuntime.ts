/* MyGo Music 插件运行时。

   MyGo 的插件是一个目录：plugin.json（清单）+ index.js（ESM 导出）+ 若干相对 import 的模块。
   index.js 里到处是 `export async function search({query, kind, offset})`，
   网络请求用全局 fetch，持久化用全局 host.storage —— 这里把这套约定在 WebView 里补齐：
   fetch 走后端 HttpRequest（绕 CORS），host.storage 走后端落盘，
   ESM 用一层很薄的转换编成普通函数执行。 */

import {bridge} from './pluginRuntime'

type AnyObj = Record<string, any>

/* ---------- MD5（插件签名用，纯 JS 实现） ---------- */

function md5hex(input: any): string {
  const str = unescape(encodeURIComponent(String(input)))
  const bytes: number[] = []
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i))
  const n = bytes.length
  const padded = bytes.slice()
  padded.push(0x80)
  while (padded.length % 64 !== 56) padded.push(0)
  const lenLo = (n * 8) >>> 0
  const lenHi = Math.floor((n * 8) / 4294967296) >>> 0
  padded.push(lenLo & 255, (lenLo >>> 8) & 255, (lenLo >>> 16) & 255, (lenLo >>> 24) & 255)
  padded.push(lenHi & 255, (lenHi >>> 8) & 255, (lenHi >>> 16) & 255, (lenHi >>> 24) & 255)

  const K: number[] = []
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < padded.length; off += 64) {
    const M: number[] = []
    for (let j = 0; j < 16; j++) {
      const p0 = off + j * 4
      M[j] = (padded[p0] | (padded[p0 + 1] << 8) | (padded[p0 + 2] << 16) | (padded[p0 + 3] << 24)) >>> 0
    }
    let A = a0, B = b0, C = c0, D = d0
    for (let j = 0; j < 64; j++) {
      let F: number
      let g: number
      if (j < 16) { F = (B & C) | (~B & D); g = j }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16 }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * j) % 16 }
      F = (F + A + K[j] + M[g]) | 0
      A = D; D = C; C = B
      const sh = S[j]
      B = (B + ((F << sh) | (F >>> (32 - sh)))) | 0
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }
  const hex = (v: number) => {
    let out = ''
    for (let i = 0; i < 4; i++) out += ((v >>> (i * 8)) & 255).toString(16).padStart(2, '0')
    return out
  }
  return hex(a0) + hex(b0) + hex(c0) + hex(d0)
}

/* ---------- AES-ECB（MyGo 规范 host.crypto.aesEcbEncrypt(key, text)） ----------
   AES-128/192/256、ECB 模式、PKCS#7 补齐，输出小写 hex。纯同步实现：
   插件是这样用的 `host.crypto.aesEcbEncrypt(key, json)`，拿回来直接拼进请求参数，
   没有 await 的机会，所以不能用 WebCrypto（它只有异步接口）。 */

const _mul2 = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff

function _gmul(a: number, b: number): number {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a = _mul2(a)
    b >>= 1
  }
  return r & 0xff
}

// S 盒按有限域求逆 + 仿射变换算出来，避免手抄 256 个常量出错
const SBOX: number[] = (() => {
  const inv = new Array(256).fill(0)
  for (let i = 1; i < 256; i++) {
    for (let j = 1; j < 256; j++) {
      if (_gmul(i, j) === 1) {
        inv[i] = j
        break
      }
    }
  }
  const s = new Array(256)
  for (let i = 0; i < 256; i++) {
    const x = inv[i]
    const rot = (n: number) => ((x << n) | (x >> (8 - n))) & 0xff
    s[i] = x ^ rot(1) ^ rot(2) ^ rot(3) ^ rot(4) ^ 0x63
  }
  return s
})()

function _expandKey(key: Uint8Array): {w: Uint8Array; rounds: number} {
  const nk = key.length / 4
  const rounds = nk + 6
  const total = 4 * (rounds + 1)
  const w = new Uint8Array(total * 4)
  w.set(key, 0)
  let rcon = 1
  for (let i = nk; i < total; i++) {
    let t = [w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]]
    if (i % nk === 0) {
      t = [SBOX[t[1]], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]
      t[0] ^= rcon
      rcon = _mul2(rcon)
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((v) => SBOX[v])
    }
    for (let k = 0; k < 4; k++) w[i * 4 + k] = w[(i - nk) * 4 + k] ^ t[k]
  }
  return {w, rounds}
}

function _encryptBlock(block: Uint8Array, w: Uint8Array, rounds: number): Uint8Array {
  const s = Uint8Array.from(block)
  for (let i = 0; i < 16; i++) s[i] ^= w[i]
  for (let r = 1; r <= rounds; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]
    const t = s.slice()
    for (let row = 1; row < 4; row++) {
      for (let c = 0; c < 4; c++) s[row + 4 * c] = t[row + 4 * ((c + row) % 4)]
    }
    if (r < rounds) {
      for (let c = 0; c < 4; c++) {
        const i = 4 * c
        const a0 = s[i]
        const a1 = s[i + 1]
        const a2 = s[i + 2]
        const a3 = s[i + 3]
        s[i] = _mul2(a0) ^ (_mul2(a1) ^ a1) ^ a2 ^ a3
        s[i + 1] = a0 ^ _mul2(a1) ^ (_mul2(a2) ^ a2) ^ a3
        s[i + 2] = a0 ^ a1 ^ _mul2(a2) ^ (_mul2(a3) ^ a3)
        s[i + 3] = (_mul2(a0) ^ a0) ^ a1 ^ a2 ^ _mul2(a3)
      }
    }
    const off = r * 16
    for (let i = 0; i < 16; i++) s[i] ^= w[off + i]
  }
  return s
}

function _utf8Bytes(v: any): number[] {
  const s = String(v ?? '')
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (i + 1 < s.length && (c & 0xfc00) === 0xd800 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00)
      i++
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

/* 规范是 (key, text)；也容忍被写成 (text, key)：key 一定是 16/24/32 字节的那个。 */
function aesEcbEncrypt(keyOrText: any, textOrKey: any): string {
  let key = _utf8Bytes(keyOrText)
  let text = _utf8Bytes(textOrKey)
  if (![16, 24, 32].includes(key.length) && [16, 24, 32].includes(text.length)) {
    const t = key
    key = text
    text = t
  }
  if (![16, 24, 32].includes(key.length)) {
    throw new Error('aesEcbEncrypt 的密钥必须是 16/24/32 字节，拿到 ' + key.length + ' 字节')
  }
  const pad = 16 - (text.length % 16)
  for (let i = 0; i < pad; i++) text.push(pad)
  const {w, rounds} = _expandKey(Uint8Array.from(key))
  let hex = ''
  for (let i = 0; i < text.length; i += 16) {
    const out = _encryptBlock(Uint8Array.from(text.slice(i, i + 16)), w, rounds)
    for (let j = 0; j < 16; j++) hex += out[j].toString(16).padStart(2, '0')
  }
  return hex
}

/* ---------- axios 的最小实现（走后端） ---------- */

async function rawRequest(
  url: string,
  method: string,
  headers: AnyObj,
  body: string
): Promise<{ status: number; body: string; err: string }> {
  const app = bridge()
  if (!app?.HttpRequest) throw new Error('后端未就绪')
  const r = await app.HttpRequest(url, method, headers || {}, body || '')
  return { status: r?.status ?? 0, body: r?.body ?? '', err: r?.err ?? '' }
}

function makeAxios(base: AnyObj = {}) {
  // 插件常见写法：const axios = require('axios').default
  //            axios.defaults.timeout = 10000
  //            axios.defaults.headers.common = {'User-Agent': ..., Referer: ...}
  //            axios.get(url, {params: {...}})
  // 这里要真的把 defaults 合并进每次请求，否则平台接口会因缺 UA/Referer 返回空。
  const defaults: AnyObj = {
    headers: {common: {}},
    timeout: 0,
    ...(base || {}),
  }
  if (!defaults.headers) defaults.headers = {common: {}}
  if (!defaults.headers.common) defaults.headers.common = {}

  const buildUrl = (target: string, params: AnyObj) => {
    if (!params) return target
    const parts: string[] = []
    Object.keys(params).forEach((k) => {
      const v = params[k]
      if (v == null) return
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val))
    })
    if (!parts.length) return target
    return target + (target.indexOf('?') >= 0 ? '&' : '?') + parts.join('&')
  }

  const request = async (cfg: AnyObj) => {
    const method = String(cfg.method || 'GET').toUpperCase()
    const headers: AnyObj = {}
    Object.assign(headers, defaults.headers.common || {})
    const byMethod = defaults.headers[method.toLowerCase()]
    if (byMethod) Object.assign(headers, byMethod)
    if (base && base.headers) Object.assign(headers, base.headers)
    if (cfg.headers) Object.assign(headers, cfg.headers)

    let data = cfg.data
    let body = ''
    if (data != null) {
      if (typeof data === 'string') body = data
      else if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) body = data.toString()
      else {
        body = JSON.stringify(data)
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json'
        }
      }
    }

    const target = buildUrl(cfg.url || cfg.uri || '', cfg.params)
    const r = await rawRequest(target, method, headers, body)
    const okStatus = r.status >= 200 && r.status < 300
    if (r.err || r.status === 0 || !okStatus) {
      const e: any = new Error(r.err || 'HTTP ' + r.status)
      e.response = {status: r.status, data: r.body, headers: {}}
      e.config = cfg
      throw e
    }

    let parsed: any = r.body
    if (cfg.responseType === 'text' || cfg.responseType === 'document') {
      parsed = r.body
    } else {
      const trimmed = (r.body || '').trim()
      if (cfg.responseType === 'json' || /^[\[{]/.test(trimmed)) {
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          parsed = r.body
        }
      }
    }
    return {data: parsed, status: r.status, statusText: String(r.status), headers: {}, config: cfg}
  }

  const inst: AnyObj = {
    request,
    get: (url: string, cfg: AnyObj = {}) => request({...cfg, url, method: 'GET'}),
    post: (url: string, data?: any, cfg: AnyObj = {}) => request({...cfg, url, method: 'POST', data}),
    put: (url: string, data?: any, cfg: AnyObj = {}) => request({...cfg, url, method: 'PUT', data}),
    head: (url: string, cfg: AnyObj = {}) => request({...cfg, url, method: 'HEAD'}),
    defaults,
    create: (cfg: AnyObj = {}) => makeAxios(cfg),
    interceptors: {
      request: {use: () => 0},
      response: {use: () => 0},
    },
    CancelToken: {source: () => ({token: {}, cancel: () => {}})},
  }
  inst.default = inst
  return inst
}


const moduleCache = new Map<string, AnyObj>()
const codeCache = new Map<string, string>()
const storageCache = new Map<string, Map<string, any>>()
const saveTimers = new Map<string, any>()

const readFile = async (id: string, rel: string): Promise<string> => {
  const app: any = bridge()
  if (rel === '') {
    // 主文件：后端按 plugin.json 的 main 决定
    const code = await app.PluginSource(id)
    if (typeof code !== 'string' || !code.trim()) throw new Error('读不到插件主文件')
    return code
  }
  const code = await app.PluginFile(id, rel)
  if (typeof code !== 'string' || !code.trim()) throw new Error('读不到插件文件：' + rel)
  return code
}

/* 相对路径解析：'./auth-qq.js' 相对当前文件所在目录 */
function resolveRel(from: string, spec: string): string {
  if (!spec.startsWith('.')) {
    throw new Error('插件只支持相对路径 import：' + spec)
  }
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const segs: string[] = []
  for (const part of (dir ? dir + '/' + spec : spec).split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      segs.pop()
      continue
    }
    segs.push(part)
  }
  return segs.join('/')
}

/* ESM → 普通函数体。只处理插件里真实出现的几种写法，够用且不误伤。 */
function toCjs(code: string): string {
  const exported: string[] = []
  let src = code

  // import {a, b as c} from './x.js'
  src = src.replace(
    /import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/g,
    (_m, clause: string, _q: string, spec: string) => {
      const c = clause.trim()
      if (c.startsWith('*')) {
        const name = c.replace(/^[^A-Za-z0-9_$]*\s*as\s+/i, '').trim() || 'mod'
        return 'const ' + name + ' = __reqBySpec(' + JSON.stringify(spec) + ');'
      }
      if (c.startsWith('{')) {
        const inner = c.slice(1, -1)
        const pairs = inner
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const [a, b] = s.split(/\s+as\s+/)
            return b ? a + ': ' + b : a
          })
        return 'const { ' + pairs.join(', ') + ' } = __reqBySpec(' + JSON.stringify(spec) + ');'
      }
      if (c.includes(',')) {
        const [def, ...rest] = c.split(',')
        const named = rest.join(',').trim()
        const t = '__reqBySpec(' + JSON.stringify(spec) + ')'
        let out = 'const ' + def.trim() + ' = (' + t + '.default ?? ' + t + ');'
        if (named.startsWith('{')) {
          const inner = named.slice(1, -1)
          const pairs = inner
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const [a, b] = s.split(/\s+as\s+/)
              return b ? a + ': ' + b : a
            })
          out += 'const { ' + pairs.join(', ') + ' } = ' + t + ';'
        }
        return out
      }
      const t = '__reqBySpec(' + JSON.stringify(spec) + ')'
      return 'const ' + c + ' = (' + t + '.default ?? ' + t + ');'
    }
  )

  // 裸 import './x.js'
  src = src.replace(/import\s+(['"])([^'"]+)\1\s*;?/g, (_m, _q: string, spec: string) => {
    return '__reqBySpec(' + JSON.stringify(spec) + ');'
  })

  // export async function / export function / export class
  src = src.replace(
    /export\s+(default\s+)?(async\s+)?(function|class)\s+([A-Za-z0-9_$]+)/g,
    (_m, def: string, asy: string, kind: string, name: string) => {
      if (def) return '__exports.default = '
      exported.push(name)
      return (asy || '') + kind + ' ' + name
    }
  )
  // export const / let / var
  src = src.replace(
    /export\s+(const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g,
    (_m, kind: string, name: string) => {
      exported.push(name)
      return kind + ' ' + name + ' ='
    }
  )
  // export { a, b as c }
  src = src.replace(/export\s*\{([^}]*)\}(\s*from\s*(['"])[^'"]+\3)?\s*;?/g, (_m, inner: string) => {
    inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => {
        const [a, b] = s.split(/\s+as\s+/)
        exported.push(b ? a + ' as ' + b : a)
      })
    return ''
  })
  // export default expr
  src = src.replace(/export\s+default\s+/g, '__exports.default = ')

  const epilogue = exported.length
    ? '\n;' +
      exported
        .map((e) => {
          const [orig, alias] = e.split(' as ')
          return '__exports.' + (alias || orig).trim() + ' = ' + orig.trim() + ';'
        })
        .join('')
    : ''
  return src + epilogue
}

/* ---------- host 注入 ---------- */

function storageOf(id: string): Map<string, any> {
  let st = storageCache.get(id)
  if (!st) {
    st = new Map()
    storageCache.set(id, st)
  }
  return st
}

let appDataDir = ''
// 插件自己的安装目录（host.dir）：插件用它拼自带程序，如 bin/win32-amd64/ffmpeg.exe
const pluginRealDir = new Map<string, string>()
// 插件声明的设置项取值（<dataDir>/plugin-settings.json 里按 id 分组存）
const pluginSettings: Record<string, Record<string, string>> = {}

async function ensureDataDir(): Promise<string> {
  if (appDataDir) return appDataDir
  const app: any = bridge()
  if (app?.GetSettings) {
    try {
      const s = await app.GetSettings()
      appDataDir = String(s?.dataDir || '')
    } catch {
      /* 拿不到就留空 */
    }
  }
  return appDataDir
}

async function initSettings(id: string): Promise<void> {
  const app: any = bridge()
  if (!app?.PluginSettings) return
  try {
    const {data} = pairOf<Record<string, string>>(await app.PluginSettings(id))
    pluginSettings[id] = data && typeof data === 'object' ? {...data} : {}
  } catch {
    pluginSettings[id] = {}
  }
}

export function setPluginSettingCache(id: string, values: Record<string, string>) {
  pluginSettings[id] = {...values}
}

export function getPluginSettingCache(id: string): Record<string, string> {
  return pluginSettings[id] || {}
}

async function initStorage(id: string): Promise<void> {
  if (storageCache.get(id)?.size) return
  const app: any = bridge()
  if (!app?.PluginStorage) return
  const raw = await app.PluginStorage(id)
  if (typeof raw !== 'string' || !raw.trim()) return
  try {
    const obj = JSON.parse(raw)
    const st = storageOf(id)
    Object.keys(obj).forEach((k) => {
      if (!st.has(k)) st.set(k, obj[k])
    })
  } catch {
    /* 数据坏了就当空的 */
  }
}

function scheduleSave(id: string) {
  const app: any = bridge()
  if (!app?.SavePluginStorage) return
  clearTimeout(saveTimers.get(id))
  saveTimers.set(
    id,
    setTimeout(() => {
      const obj: AnyObj = {}
      storageOf(id).forEach((v, k) => (obj[k] = v))
      Promise.resolve(app.SavePluginStorage(id, JSON.stringify(obj))).catch(() => {})
    }, 400)
  )
}

/* Wails 的多返回值在 JS 里会变成数组（也可能被合并成单值），统一在这里拆。 */
function pairOf<T>(r: any): {data: T | null; err: string} {
  if (Array.isArray(r)) {
    return {data: (r[0] ?? null) as T | null, err: typeof r[1] === 'string' ? r[1] : ''}
  }
  if (r && typeof r === 'object') return {data: r as T, err: ''}
  return {data: null, err: typeof r === 'string' ? r : ''}
}

/* host.spawn(bin, args) 的契约（插件是这么用的）：
     const p = host.spawn(bin, args); const code = await p.wait(); const said = await p.errorOutput()
   后端一次跑完再回，这里包成插件期待的两个方法。 */
function makeSpawn() {
  return (bin: string, args?: any[]) => {
    const realArgs = Array.isArray(args) ? args.map((x) => String(x)) : []
    let result: {code: number; stderr: string} | null = null
    let pending: Promise<void> | null = null

    const run = async () => {
      const app: any = bridge()
      if (!app?.RunProcess) throw new Error('后端不支持运行本机程序')
      const {data, err} = pairOf<{code: number; stdout: string; stderr: string}>(await app.RunProcess(bin, realArgs, 300))
      if (err) throw new Error(err)
      result = {code: Number(data?.code ?? 0), stderr: String(data?.stderr || '')}
    }

    return {
      wait: async () => {
        if (!result) {
          pending = pending || run()
          await pending
        }
        return result?.code ?? 0
      },
      errorOutput: async () => {
        if (!result) {
          pending = pending || run()
          try {
            await pending
          } catch {
            /* 报错在 wait() 里抛，这里只是拿输出 */
          }
        }
        return result?.stderr || ''
      },
      stdout: async () => '',
      kill: () => {},
    }
  }
}

function makeHost(id: string, dataDir: string): AnyObj {
  const st = storageOf(id)
  const sep = dataDir.includes('\\') ? '\\' : '/'
  const pluginDataDir = dataDir ? dataDir + sep + 'plugin-data' + sep + id : id
  return {
    // 插件会自己拼临时文件路径（转码、缓存），所以要给一个真实可写目录
    dataDir: pluginDataDir,
    dir: pluginRealDir.get(id) || pluginDataDir,
    platform: 'windows',
    arch: 'amd64',
    language: () => 'zh-CN',
    // 少数插件用它给用户名兜底
    nickname: '',
    uid: '',
    // 桌面版没有 localhost 服务，插件如果依赖它会自己降级
    localhost: '',
    spawn: makeSpawn(),
    t: (s: any) => String(s ?? ''),
    setting: (key: string) => {
      const v = (pluginSettings[id] || {})[key]
      return v === undefined ? '' : String(v)
    },
    storage: {
      get: (k: string) => st.get(k),
      set: (k: string, v: any) => {
        st.set(k, v)
        scheduleSave(id)
      },
      remove: (k: string) => {
        st.delete(k)
        scheduleSave(id)
      },
    },
    crypto: {
      md5: (s: any) => md5hex(s),
      // 规范：host.crypto.aesEcbEncrypt(key, text) → AES-ECB + PKCS#7 的 hex
      aesEcbEncrypt: (key: any, text: any) => aesEcbEncrypt(key, text),
    },
    // 插件要求用系统浏览器打开网页（授权页、官方登录页）
    openURL: (url: any) => {
      const u = String(url ?? '')
      if (!/^https?:\/\//i.test(u)) throw new Error('openURL 只接受 http/https 地址')
      const app: any = bridge()
      if (app?.OpenExternal) {
        try {
          const p: any = app.OpenExternal(u)
          if (p && typeof p.catch === 'function') p.catch(() => window.open(u, '_blank'))
        } catch {
          window.open(u, '_blank')
        }
      } else window.open(u, '_blank')
    },
    // 插件清理自己的缓存目录
    removeDataDir: (name: any) => {
      const n = String(name ?? '')
      if (!n || n.includes('..') || n.includes('/') || n.includes('\\')) throw new Error('removeDataDir 只接受本插件目录内的名字')
      const app: any = bridge()
      if (app?.RemovePluginDataDir) {
        try {
          const p: any = app.RemovePluginDataDir(id, n)
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch { /* 删不了就算了，插件只是清缓存 */ }
      }
    },
    // 独立窗口里登录并读 cookie：WebView 里做不到（跨域读不到 Cookie，
    // 插件换成网页登录时请把 Sign-in Method 改成 qr 走扫码）
    webSignIn: async () => {
      throw new Error('这个播放器不支持网页登录，请在插件设置里把登录方式改成 qr（扫码）')
    },
    waitForRedirect: async () => {
      throw new Error('这个播放器不支持浏览器跳转回环登录，请改用扫码登录')
    },
    // 扫码登录：把二维码内容交给界面画出来，等用户确认（或超时）
    signInPrompt: (o: any) =>
      new Promise<void>((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          window.dispatchEvent(
            new CustomEvent('mygo-signin-prompt', {
              detail: {qr: String(o?.qr || ''), text: String(o?.text || ''), pluginId: id, done},
            })
          )
        } catch {
          done()
          return
        }
        setTimeout(done, 180000)
      }),
    js: {},
  }
}

/* fetch() 走后端，避免 CORS；返回一个够插件用的 Response 形状。 */
function makeFetch(): any {
  return async (input: any, init: AnyObj = {}) => {
    const app: any = bridge()
    if (!app?.HttpRequest) throw new Error('后端未就绪')
    const url = typeof input === 'string' ? input : String(input?.url || '')
    const method = String(init.method || 'GET').toUpperCase()
    const headers: AnyObj = {}
    const h = init.headers
    if (h) {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v: string, k: string) => (headers[k] = v))
      else Object.assign(headers, h)
    }
    let body = ''
    if (init.body != null) {
      if (typeof init.body === 'string') body = init.body
      else if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) body = init.body.toString()
      else body = JSON.stringify(init.body)
    }
    const manualRedirect = String(init.redirect || '').toLowerCase() === 'manual'
    const r = await app.HttpRequest(url, method, headers, body, manualRedirect)
    if (r?.err) throw new Error(r.err)
    const text = r?.body ?? ''
    const status = r?.status ?? 0
    const respHeaders = r?.headers || {}
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: {
        get: (k: string) => respHeaders[String(k).toLowerCase()] ?? null,
        has: (k: string) => respHeaders[String(k).toLowerCase()] != null,
        // 后端把多个同名头用 \n 拼在一起；登录插件要靠它对每条 Set-Cookie 单独取值
        getSetCookie: () => {
          const raw = String(respHeaders['set-cookie'] || '')
          return raw ? raw.split('\n').filter(Boolean) : []
        },
        forEach: (fn: (v: string, k: string) => void) => {
          Object.keys(respHeaders).forEach((k) => fn(String(respHeaders[k]), k))
        },
      },
      json: async () => JSON.parse(text),
      text: async () => text,
      // 二进制响应：后端会把图片这类内容的原始字节以 base64 带回来，
      // 直接 TextEncoder 编码文本会把非 UTF-8 字节整坏（插件解二维码就失败在这里）
      arrayBuffer: async () => {
        const b64 = String(r?.bodyB64 ?? (r as any)?.BodyB64 ?? '')
        if (b64) {
          const bin = atob(b64)
          const buf = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
          return buf.buffer
        }
        // 文本响应本来就不该用 arrayBuffer；走到这里说明后端没给原始字节。
        // 抛明确一点的错，别让插件那边报「格式不支持」把事情带偏。
        throw new Error(
          '取二进制失败：后端没返回原始字节（status=' + status +
          '，type=' + String(respHeaders['content-type'] || '无') +
          '，len=' + text.length + '）'
        )
      },
      blob: async () => {
        const b64 = String(r?.bodyB64 || '')
        let bytes: Uint8Array
        if (b64) {
          const bin = atob(b64)
          bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        } else {
          bytes = new TextEncoder().encode(text)
        }
        return new Blob([bytes], {type: String(respHeaders['content-type'] || '')})
      },
      clone: () => makeFetchClone(),
    }
  }
}

// 极简 clone：插件偶尔会 clone 一份再用，给它一个独立但内容相同的响应
function makeFetchClone(): any {
  return {
    ok: true,
    status: 200,
    headers: {get: () => null, has: () => false},
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/* ---------- 加载 ---------- */

async function prepare(id: string, rel: string): Promise<void> {
  const key = id + '::' + rel
  if (codeCache.has(key)) return
  const code = await readFile(id, rel)
  codeCache.set(key, code)
  const specs = Array.from(code.matchAll(/from\s*(['"])(\.\S*?)\1/g)).map((m) => m[2])
  for (const spec of specs) {
    await prepare(id, resolveRel(rel, spec))
  }
}

function build(id: string, rel: string, built: Map<string, AnyObj>): AnyObj {
  const key = id + '::' + rel
  const hit = built.get(key)
  if (hit) return hit
  const exportsObj: AnyObj = {}
  built.set(key, exportsObj)
  const reqBySpec = (spec: string) => {
    const child = resolveRel(rel, spec)
    return build(id, child, built)
  }
  const code = codeCache.get(key) || ''
  let fn: any
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(
      'exports',
      'module',
      'require',
      'host',
      'fetch',
      '__exports',
      '__reqBySpec',
      'console',
      toCjs(code) + '\n//# sourceURL=hulu-mygo://' + id + '/' + (rel || 'index.js')
    )
  } catch (e: any) {
    throw new Error('插件语法错误：' + String(e?.message || e))
  }
  const moduleObj = {exports: exportsObj}
  const noopConsole = {log() {}, info() {}, warn() {}, error() {}, debug() {}}
  try {
    fn(
      exportsObj,
      moduleObj,
      reqBySpec,
      makeHost(id, appDataDir),
      makeFetch(),
      exportsObj,
      reqBySpec,
      noopConsole
    )
  } catch (e: any) {
    throw new Error('插件执行出错：' + String(e?.message || e))
  }
  return moduleObj.exports as AnyObj
}

/* 加载一个 MyGo 插件，返回它的导出对象（search / stream / lyrics / home …） */
export async function loadMyGoPlugin(id: string): Promise<AnyObj> {
  const hit = moduleCache.get(id)
  if (hit) return hit
  await ensureDataDir()
  if (!pluginRealDir.get(id)) {
    try {
      const app: any = bridge()
      if (app?.PluginDir) {
        const r = await app.PluginDir(id)
        const v = Array.isArray(r) ? r[0] : r
        if (typeof v === 'string' && v) pluginRealDir.set(id, v)
      }
    } catch { /* 拿不到就退回数据目录 */ }
  }
  await initStorage(id)
  await initSettings(id)
  codeCache.clear()
  await prepare(id, '')
  const built = new Map<string, AnyObj>()
  const exp = build(id, '', built)
  moduleCache.set(id, exp)
  return exp
}

export function clearMyGoCache(id?: string) {
  if (id) {
    moduleCache.delete(id)
    ;Array.from(codeCache.keys())
      .filter((k) => k.startsWith(id + '::'))
      .forEach((k) => codeCache.delete(k))
  } else {
    moduleCache.clear()
    codeCache.clear()
  }
}

/* ---------- 数据模型对齐 ---------- */

export type MyGoItem = {
  id: string
  title: string
  artist: string
  album: string
  artwork: string
  duration: number
  raw: AnyObj
}

function mapTrack(t: AnyObj): MyGoItem {
  const artists: any[] = Array.isArray(t?.artists) ? t.artists : []
  return {
    id: String(t?.id ?? ''),
    title: String(t?.name ?? t?.title ?? '未命名'),
    artist: artists.map((a) => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean).join(' / '),
    album: String(t?.album?.name ?? ''),
    artwork: String(t?.album?.imageUrl ?? t?.imageUrl ?? ''),
    duration: Number(t?.duration) || 0,
    raw: t || {},
  }
}

export async function mygoSearch(id: string, keyword: string, page = 1): Promise<MyGoItem[]> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.search !== 'function') throw new Error('这个插件不支持搜索')
  const offset = Math.max(0, (page - 1) * 20)
  const res = await mod.search({query: keyword, kind: 'tracks', offset})
  const list: any[] = res?.tracks || res?.data || res?.items || []
  if (!Array.isArray(list)) return []
  return list.map(mapTrack).filter((x) => x.id)
}

export async function mygoStream(
  id: string,
  item: AnyObj,
  quality = 'standard'
): Promise<{url: string; referer: string}> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.stream !== 'function') throw new Error('这个插件不支持取流')
  const sid = String(item?.id ?? item?.raw?.id ?? '')
  const res = await mod.stream({id: sid, quality})
  const url = String(res?.url ?? '')
  if (!url) throw new Error('插件没给播放地址（可能是 VIP 曲或无版权）')
  const headers = res?.headers || {}
  const referer = headers.Referer || headers.referer || ''
  return {url, referer}
}

export async function mygoLyric(
  id: string,
  item: AnyObj
): Promise<{time: number; text: string}[]> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.lyrics !== 'function') return []
  const sid = String(item?.id ?? item?.raw?.id ?? '')
  const res = await mod.lyrics({id: sid})
  const out: {time: number; text: string}[] = []
  if (Array.isArray(res?.lines) && res.lines.length) {
    for (const l of res.lines) {
      out.push({time: Number(l.start) || 0, text: String(l.text || '')})
    }
    return out
  }
  const raw = String(res?.lrc || res?.rawLrc || '')
  if (!raw) return []
  for (const line of raw.split('\n')) {
    const m = line.match(/\[(\d+):(\d+)(?:[.:](\d+))?\]\s*(.*)/)
    if (!m) continue
    const ms =
      Number(m[1]) * 60000 +
      Number(m[2]) * 1000 +
      Number((m[3] || '0').padEnd(3, '0').slice(0, 3))
    if (m[4]) out.push({time: ms, text: m[4].trim()})
  }
  return out
}

/* 首页 / 浏览页（MyGo 用 home() / browse({page})，桌面版暂时只用它来试跑） */
export async function mygoHome(id: string): Promise<AnyObj | null> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.home !== 'function') return null
  return await mod.home()
}

/* ---------- 首页 / 更多页 / 歌单 / 专辑 ----------
   MyGo 插件的 home() / browse({page}) 返回的是一棵 JSON 描述（music.Browse：
   {title, sections:[{title, subtitle, tracks, albums, playlists, morePage}]}），
   不是 HTML。这里把它抹平成前端能直接画的结构。 */

export type CardKind = 'album' | 'playlist' | 'station' | 'artist' | 'show' | 'link'
export type HomeCard = {id: string; name: string; cover: string; sub: string; kind: CardKind}
export type HomeSection = {
  title: string
  subtitle: string
  empty: string
  page: string
  tracks: MyGoItem[]
  cards: HomeCard[]
}
export type HomeView = {title: string; sections: HomeSection[]}

function artistsOf(t: AnyObj): string {
  const a: any[] = Array.isArray(t?.artists) ? t.artists : []
  return a.map((x) => (typeof x === 'string' ? x : x?.name || '')).filter(Boolean).join(' / ')
}

// MyGo 的 Section 有六种卡片：专辑 / 歌单 / 电台 / 艺人 / 节目 / 链接，
// 外加 tracks 这一组能直接播的歌。插件只给其中几种，缺的就空着。
function toCard(x: AnyObj, kind: CardKind): HomeCard {
  const name = String(x?.name ?? x?.title ?? x?.label ?? '')
  return {
    id: String(x?.id ?? ''),
    name,
    cover: String(x?.imageUrl ?? x?.image ?? x?.cover ?? x?.artwork ?? x?.logo ?? ''),
    sub: String(x?.artists ? artistsOf(x) : x?.artist ?? x?.author ?? x?.description ?? x?.url ?? ''),
    kind,
  }
}

function normSection(s: AnyObj): HomeSection {
  const cards: HomeCard[] = []
  const push = (arr: any, kind: CardKind) => {
    if (Array.isArray(arr)) arr.forEach((x) => { if (x) cards.push(toCard(x, kind)) })
  }
  push(s?.playlists, 'playlist')
  push(s?.albums, 'album')
  push(s?.stations, 'station')
  push(s?.shows, 'show')
  push(s?.artists, 'artist')
  push(s?.links, 'link')
  // 歌单补一个「N 首」，插件的 playlists 有时带 tracks 有时只带 trackCount
  const pls: any[] = Array.isArray(s?.playlists) ? s.playlists : []
  pls.forEach((p, i) => {
    const c = cards[i]
    if (c && c.kind === 'playlist' && !c.sub) {
      const n = Array.isArray(p?.tracks) ? p.tracks.length : Number(p?.trackCount) || 0
      if (n) c.sub = n + ' 首'
    }
  })
  return {
    title: String(s?.title ?? ''),
    subtitle: String(s?.subtitle ?? ''),
    empty: String(s?.empty ?? ''),
    page: String(s?.morePage ?? ''),
    tracks: (Array.isArray(s?.tracks) ? s.tracks : []).map(mapTrack),
    cards,
  }
}

function normBrowse(raw: AnyObj): HomeView {
  return {
    title: String(raw?.title ?? ''),
    sections: (Array.isArray(raw?.sections) ? raw.sections : []).map(normSection),
  }
}

export async function mygoHomeView(id: string): Promise<HomeView> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.home !== 'function') throw new Error('这个插件没有首页')
  return normBrowse(await mod.home())
}

export async function mygoBrowseView(id: string, page: string): Promise<HomeView> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.browse !== 'function') throw new Error('这个插件不支持更多页')
  return normBrowse(await mod.browse({page}))
}

export async function mygoPlaylistTracks(id: string, pid: string): Promise<{name: string; tracks: MyGoItem[]}> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.playlist !== 'function') throw new Error('这个插件不支持打开歌单')
  const r = await mod.playlist({id: pid})
  return {name: String(r?.name ?? '歌单'), tracks: (Array.isArray(r?.tracks) ? r.tracks : []).map(mapTrack)}
}

export async function mygoAlbumTracks(id: string, aid: string): Promise<{name: string; tracks: MyGoItem[]}> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.album !== 'function') throw new Error('这个插件不支持打开专辑')
  const r = await mod.album({id: aid})
  return {name: String(r?.name ?? '专辑'), tracks: (Array.isArray(r?.tracks) ? r.tracks : []).map(mapTrack)}
}

/* 登录状态变了就广播一下，主界面据此刷新顶部账号条 */
function notifyAccountChanged(pluginId: string) {
  try {
    window.dispatchEvent(new CustomEvent('mygo-account-changed', {detail: {pluginId}}))
  } catch { /* 忽略 */ }
}

/* 插件登录：signIn() 会走 host.signInPrompt 弹二维码；account() 读当前登录态。 */
export async function mygoSignIn(pluginId: string): Promise<any> {
  const m: AnyObj = await loadMyGoPlugin(pluginId)
  if (typeof m.signIn !== 'function') throw new Error('这个插件不需要登录，或没有提供 signIn')
  const out = await m.signIn()
  clearMyGoCache(pluginId)
  notifyAccountChanged(pluginId)
  return out
}


/* 插件能力探测：不信任 plugin.json 的声明，直接看模块真导出了什么。
   有些插件（尤其打包成 dist 的）manifest 里不会写 signIn，但函数是有的。 */
export async function mygoCapabilities(id: string): Promise<{signIn: boolean; account: boolean}> {
  try {
    const m: AnyObj = await loadMyGoPlugin(id)
    return {
      signIn: typeof m.signIn === 'function',
      account: typeof m.account === 'function',
    }
  } catch {
    return {signIn: false, account: false}
  }
}

/* 插件登出：先让插件自己清（有的会顺手注销远端 session），再兜底把本地 storage 清空。
   凭证一般就存在 host.storage 里（plugin-data/<id>.json），不清的话下次 ack 还在登录态。 */
export async function mygoSignOut(pluginId: string): Promise<{name: string}> {
  let who: any = null
  try {
    who = await mygoAccount(pluginId)
  } catch { /* 读不到账号也照样往下清 */ }

  try {
    const m: AnyObj = await loadMyGoPlugin(pluginId)
    if (typeof m.signOut === 'function') await m.signOut()
  } catch { /* 插件没有 signOut 就只清本地 */ }

  // 内存缓存和落盘数据一起清，避免「点了登出还是登录态」
  storageCache.delete(pluginId)
  const app: any = bridge()
  if (app?.SavePluginStorage) {
    try {
      await app.SavePluginStorage(pluginId, '{}')
    } catch { /* 写不进去也不阻塞界面 */ }
  }
  clearMyGoCache(pluginId)
  notifyAccountChanged(pluginId)
  return {name: String(who?.name || who?.nickname || '')}
}

export async function mygoAccount(pluginId: string): Promise<any> {
  const m: AnyObj = await loadMyGoPlugin(pluginId)
  if (typeof m.account !== 'function') return null
  try {
    return await m.account()
  } catch {
    return null
  }
}

export async function mygoStations(id: string): Promise<AnyObj[]> {
  const mod = await loadMyGoPlugin(id)
  if (typeof mod.stations !== 'function') return []
  const res = await mod.stations()
  return Array.isArray(res) ? res : []
}
