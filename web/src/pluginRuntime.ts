/* 插件桥接层。

   现在只支持 MyGo Music 规范的插件：一个目录（plugin.json + index.js 的 ESM 导出），
   运行时见 mygoRuntime.ts。旧 MusicFree 的单文件接口（module.exports + axios/cheerio）
   已经移除，非 MyGo 插件不会被加载。

   对外函数签名保持和之前一致（pluginSearch / pluginMediaSource / pluginLyric），
   页面代码不用跟着改。 */

import {clearMyGoCache, mygoLyric, mygoSearch, mygoStream} from './mygoRuntime'

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
}

/* ---------- 调用能力 ---------- */

export async function pluginSearch(
  pluginId: string,
  keyword: string,
  page = 1
): Promise<PluginSearchItem[]> {
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
  return await mygoStream(pluginId, item, quality)
}

export async function pluginLyric(
  pluginId: string,
  item: AnyObj
): Promise<{time: number; text: string}[]> {
  return await mygoLyric(pluginId, item)
}
