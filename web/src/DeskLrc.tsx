/* 桌面歌词窗口的页面（独立窗口，由 Go 侧 DeskLrc 建出来，URL 带 ?desklrc=1）。

   这扇窗只负责显示：歌词解析留在主窗口，那边每换一句就调 DeskLrcText 推过来，
   Go 侧再 Eval 这里的 window.__dl(line, title)。

   透明是窗口级的（WindowOptions.Transparent），所以页面底色必须全透明，
   不留一点 rgba，否则桌面上会出现一块灰。拖动用 CSS --app-region: drag。 */

import {useEffect, useState} from 'react'

export default function DeskLrc() {
  const [line, setLine] = useState('')
  const [title, setTitle] = useState('')

  useEffect(() => {
    // 透明底：html / body 都要清，少一个就会看到窗口底色
    for (const el of [document.documentElement, document.body]) {
      el.style.background = 'transparent'
      el.style.overflow = 'hidden'
    }
    document.body.style.margin = '0'
    // 开机自检横条是给主界面排障用的，桌面歌词里留着会挡字
    document.getElementById('bootdiag')?.remove()
    ;(window as any).__dl = (l: string, t: string) => {
      setLine(String(l || ''))
      setTitle(String(t || ''))
    }
  }, [])

  return (
    <div className="dl-root">
      {title && <div className="dl-title">{title}</div>}
      <div className={line ? 'dl-line' : 'dl-line dim'}>{line || '♪ 未在播放'}</div>
    </div>
  )
}
