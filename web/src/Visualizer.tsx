/* 皮肤主窗口里的可视化面板：频谱 / 示波器 / UV 电平表，点右上三个小键切换。

   数据来自 eq.ts 建好的音频图（mixed / l / r 三个 AnalyserNode）。图建不起来
   （音源没开跨源读取）时不会静音，只是这块显示「待机」。
   具体画法都在 visDraw.ts，这里只管取数据、按帧调用。
*/

import { useEffect, useRef, useState } from 'react'
import {
  type Analysts,
  type VisMode,
  type VuState,
  drawSpectrum,
  drawScope,
  drawVu,
} from './visDraw'

export type { Analysts, VisMode }

const VIS_KEY = 'qqjt-vis-mode'
const MODES: { id: VisMode; label: string; title: string }[] = [
  { id: 'spectrum', label: '频谱', title: '频谱条：实时频率能量，跟着音乐跳动' },
  { id: 'scope', label: '示波', title: '示波器：波形轨迹，带余辉拖尾' },
  { id: 'vu', label: '电平', title: 'UV 电平表：左右声道双针，带峰值保持' },
]

function initialMode(): VisMode {
  try {
    const v = localStorage.getItem(VIS_KEY)
    if (v === 'spectrum' || v === 'scope' || v === 'vu') return v
  } catch { /* 忽略 */ }
  return 'spectrum'
}

export default function Visualizer({
  ensure,
  playing,
}: {
  /** 需要时建立音频图并给出分析节点；拿不到就是 null。 */
  ensure: () => Promise<Analysts | null>
  playing: boolean
}) {
  const [mode, setMode] = useState<VisMode>(initialMode)
  const [live, setLive] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const anRef = useRef<Analysts | null>(null)
  const modeRef = useRef<VisMode>(mode)
  const playRef = useRef(playing)
  const heightsRef = useRef<number[]>([])
  const vuRef = useRef<VuState>({ l: 0, r: 0, pl: 0, pr: 0 })

  modeRef.current = mode
  playRef.current = playing

  useEffect(() => {
    try { localStorage.setItem(VIS_KEY, mode) } catch { /* 忽略 */ }
  }, [mode])

  // 播放开始时确保音频图在，之后一直复用
  useEffect(() => {
    let gone = false
    if (!playing || anRef.current) return
    ensure().then((a) => {
      if (gone) return
      anRef.current = a
      setLive(!!a)
    })
    return () => { gone = true }
  }, [playing, ensure])

  useEffect(() => {
    let raf = 0
    let frame = 0
    const mixedBuf = new Uint8Array(2048)
    const chanBuf = new Uint8Array(1024)
    const freqBuf = { current: new Uint8Array(1024) }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      frame++
      // 暂停时每 5 帧画一次，省电
      if (!playRef.current && frame % 5 !== 0) return

      const cv = canvasRef.current
      const wrap = wrapRef.current
      if (!cv || !wrap) return
      const ctx = cv.getContext('2d')
      if (!ctx) return

      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
      const w = Math.max(1, Math.floor(wrap.clientWidth))
      const h = Math.max(1, Math.floor(wrap.clientHeight))
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr
        cv.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const an = anRef.current
      const m = modeRef.current
      const on = playRef.current

      if (m === 'spectrum') drawSpectrum(ctx, w, h, an, on, cv, heightsRef, freqBuf)
      else if (m === 'scope') drawScope(ctx, w, h, an, on, cv, mixedBuf)
      else drawVu(ctx, w, h, an, on, cv, chanBuf, vuRef)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="sk-spec sk-vis" ref={wrapRef}>
      <canvas ref={canvasRef} className="sk-vis-cv" />
      <div className="sk-vis-tabs">
        {MODES.map((it) => (
          <button key={it.id} title={it.title}
                  className={mode === it.id ? 'on' : ''}
                  onClick={() => setMode(it.id)}>{it.label}</button>
        ))}
      </div>
      {!live && (
        <div className="sk-vis-idle">
          {playing ? '这个音源不支持实时波形（跨源限制）' : '待机'}
        </div>
      )}
    </div>
  )
}
