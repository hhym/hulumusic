/* 插件桥接层。

   同时支持两套插件规范，页面对外只看到同一组函数，按插件 kind 分派：
     - mygo       目录型插件（plugin.json + index.js 的 ESM 导出），运行时在 mygoRuntime.ts
     - musicfree  单文件插件（module.exports + require('axios')），运行时在 musicfreeRuntime.ts

   对外函数签名保持和之前一致（pluginSearch / pluginMediaSource / pluginLyric），
   页面代码不用跟着改。 */

import {clearMyGoCache, mygoLyric, mygoSearch, mygoStream} from './mygoRuntime'
import {clearMusicFreeCache, mfLyric, mfMediaSource, mfSearch} from './musicfreeRuntime'

type AnyObj = Record<string, any>

export const bridge = () => (window as any).go?.main?.App

export type PluginSearchItem = {
  title: string
  artist?: string
  album?: string
  artwork?: string
  duration?: number
  id?: string
  [k: string]: any
}

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function unb64url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const t = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return decodeURIComponent(escape(atob(t)))
}

/* 曲目在播放队列里靠 id 携带：plug:<插件id>:<base64url(曲目 JSON)> */
export function encodePluginTrack(pluginId: string, item: AnyObj): string {
  return 'plug:' + pluginId + ':' + b64url(JSON.stringify(item))
}

export function decodePluginTrackId(id: string): {pluginId: string; item: AnyObj} | null {
  if (!id.startsWith('plug:')) return null
  const rest = id.slice(5)
  const idx = rest.indexOf(':')
  if (idx < 0) return null
  try {
    return {pluginId: rest.slice(0, idx), item: JSON.parse(unb64url(rest.slice(idx + 1)))}
  } catch {
    return null
  }
}

export function clearPluginCache(pluginId?: string) {
  clearMyGoCache(pluginId)
  clearMusicFreeCache(pluginId)
}

/* 插件 kind 的缓存：问一次 Go 就够了，5 秒内复用，避免搜索时每个插件都打一轮 IPC。 */
let kindCache: {at: number; map: Record<string, string>} = {at: 0, map: {}}

async function pluginKindOf(id: string): Promise<string> {
  const app: any = bridge()
  if (!app?.Plugins) return 'mygo'
  if (Date.now() - kindCache.at > 5000) {
    try {
      const raw: any = await app.Plugins()
      const list: any[] = Array.isArray(raw) ? raw[0] != null ? raw[0] : raw : raw
      const map: Record<string, string> = {}
      for (const p of Array.isArray(list) ? list : []) {
        if (p && p.id) map[String(p.id)] = String(p.kind || 'mygo')
      }
      kindCache = {at: Date.now(), map}
    } catch {
      /* 问不到就按 MyGo 处理 */
    }
  }
  return kindCache.map[id] || 'mygo'
}

/* ---------- 调用能力 ---------- */

export async function pluginSearch(
  pluginId: string,
  keyword: string,
  page = 1
): Promise<PluginSearchItem[]> {
  if ((await pluginKindOf(pluginId)) === 'musicfree') {
    // MusicFree 的 item 本身就是取流/取词的入参，字段要原样带回去
    return (await mfSearch(pluginId, keyword, page)) as PluginSearchItem[]
  }
  const items = await mygoSearch(pluginId, keyword, page)
  return items.map((it) => {
    const {raw, ...rest} = it
    void raw
    return rest as PluginSearchItem
  })
}

export async function pluginMediaSource(
  pluginId: string,
  item: AnyObj,
  quality = 'standard'
): Promise<{url: string; referer: string}> {
  if ((await pluginKindOf(pluginId)) === 'musicfree') {
    return await mfMediaSource(pluginId, item, quality)
  }
  return await mygoStream(pluginId, item, quality)
}

export async function pluginLyric(
  pluginId: string,
  item: AnyObj
): Promise<{time: number; text: string}[]> {
  if ((await pluginKindOf(pluginId)) === 'musicfree') {
    return await mfLyric(pluginId, item)
  }
  return await mygoLyric(pluginId, item)
}
