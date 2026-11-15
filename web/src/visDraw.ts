/* 皮肤可视化面板的绘制层：频谱 / 示波器 / UV 电平表。
   与 React 无关，纯 canvas 函数，组件只负责取数据、按帧调用。 */

export type Analysts = { mixed: AnalyserNode; l: AnalyserNode; r: AnalyserNode }
export type VisMode = 'spectrum' | 'scope' | 'vu'
/** UV 表的指针与峰值保持状态，跨帧保存。 */
export type VuState = { l: number; r: number; pl: number; pr: number }

/** 从 CSS 变量取色，好让面板跟着皮肤变。 */
export function cvar(el: HTMLElement, name: string, fb: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fb
}

/** 对数分布的频率分桶边界（Hz），给频谱条用。 */
export function bucketEdges(bins: number, binHz: number, count: number): number[] {
  const lo = 40
  const hi = 15000
  const edges: number[] = []
  for (let i = 0; i <= count; i++) {
    const f = lo * Math.pow(hi / lo, i / count)
    const idx = Math.min(bins - 1, Math.max(0, Math.round(f / binHz)))
    edges.push(idx)
  }
  return edges
}

/* ── 频谱条 ── */
export function drawSpectrum(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  an: Analysts | null, on: boolean,
  cv: HTMLCanvasElement, heightsRef: { current: number[] },
  freqBuf: { current: Uint8Array },
) {
  ctx.clearRect(0, 0, w, h)
  const n = Math.max(12, Math.min(48, Math.floor(w / 6)))
  const padT = 4
  const base = h - 4
  const maxH = base - padT

  if (heightsRef.current.length !== n) heightsRef.current = new Array(n).fill(0)
  const heights = heightsRef.current

  const lo = cvar(cv, '--vis-lo', '#3c45c8')
  const mid = cvar(cv, '--vis-mid', '#7d88ff')
  const hi = cvar(cv, '--vis-hi', '#c9cfff')

  let bins: Uint8Array | null = null
  let edges: number[] | null = null
  if (an && on) {
    if (freqBuf.current.length !== an.mixed.frequencyBinCount) {
      freqBuf.current = new Uint8Array(an.mixed.frequencyBinCount)
    }
    const buf = freqBuf.current
    an.mixed.getByteFrequencyData(buf)
    bins = buf
    const binHz = an.mixed.context.sampleRate / 2 / an.mixed.frequencyBinCount
    edges = bucketEdges(an.mixed.frequencyBinCount, binHz, n)
  }

  const slot = w / n
  const barW = Math.max(1.5, slot - Math.max(1, slot * 0.22))

  for (let i = 0; i < n; i++) {
    let target = 0
    if (bins && edges) {
      const a = edges[i]
      const b = Math.max(a + 1, edges[i + 1])
      let peak = 0
      for (let k = a; k < b && k < bins.length; k++) if (bins[k] > peak) peak = bins[k]
      // 低频略降、高频略提，人耳上更均衡
      const tilt = 0.82 + 0.3 * (i / n)
      target = Math.min(1, Math.pow(peak / 255, 0.78) * tilt)
    }
    // 快起慢落
    heights[i] = target > heights[i] ? heights[i] + (target - heights[i]) * 0.55
      : heights[i] + (target - heights[i]) * 0.16
    const bh = Math.max(1.5, heights[i] * maxH)
    const x = i * slot + (slot - barW) / 2
    const g = ctx.createLinearGradient(0, base, 0, base - bh)
    g.addColorStop(0, lo)
    g.addColorStop(0.55, mid)
    g.addColorStop(1, hi)
    ctx.fillStyle = g
    ctx.fillRect(x, base - bh, barW, bh)
    // 顶端高光
    ctx.fillStyle = hi
    ctx.globalAlpha = 0.85
    ctx.fillRect(x, base - bh, barW, Math.min(1.6, bh))
    ctx.globalAlpha = 1
  }
}

/* ── 示波器 ── */
export function drawScope(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  an: Analysts | null, on: boolean,
  cv: HTMLCanvasElement, buf: Uint8Array,
) {
  // 余辉：把上一帧按 alpha 擦淡，露出下面皮肤自带的网格背景
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = 'rgba(0,0,0,0.16)'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'

  if (!an || !on) {
    ctx.strokeStyle = cvar(cv, '--vis-line', '#7d88ff')
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(2, h / 2)
    ctx.lineTo(w - 2, h / 2)
    ctx.stroke()
    ctx.globalAlpha = 1
    return
  }

  const size = Math.min(buf.length, an.mixed.fftSize)
  an.mixed.getByteTimeDomainData(buf.subarray(0, size))

  // 触发对齐：从一次由下向上的过中点开始画，波形就不会左右乱窜
  const mid = 128
  const span = Math.min(256, size - 2)
  let start = 0
  for (let i = 1; i < size - span; i++) {
    if (buf[i - 1] <= mid && buf[i] > mid) { start = i; break }
  }

  const line = cvar(cv, '--vis-line', '#c9cfff')
  ctx.strokeStyle = line
  ctx.lineWidth = 1.5
  ctx.beginPath()
  const step = w / span
  for (let i = 0; i < span; i++) {
    const v = (buf[start + i] - 128) / 128
    // 音乐信号的时域振幅通常只有满幅的三四成，直接按 1:1 画出来会显得很扁，
    // 这里放大 1.6 倍再夹到面板内，峰值顶到边界就停，不会画到框外。
    const reach = h / 2 - 4
    const y = h / 2 + Math.max(-reach, Math.min(reach, v * reach * 1.6))
    const x = i * step
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

/* ── UV 电平表（左右双针） ── */
export function drawVu(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  an: Analysts | null, on: boolean,
  cv: HTMLCanvasElement, buf: Uint8Array,
  vu: { current: { l: number; r: number; pl: number; pr: number } },
) {
  ctx.clearRect(0, 0, w, h)

  const dial = cvar(cv, '--vis-dial', '#8a93ea')
  const needle = cvar(cv, '--vis-needle', '#ff6a3d')
  const dim = cvar(cv, '--vis-dim', '#6a74c0')
  const hot = cvar(cv, '--vis-hot', '#ff5252')

  const targetL = an && on ? level(buf, an.l, 'l') : 0
  const targetR = an && on ? level(buf, an.r, 'r') : 0

  const s = vu.current
  // 快起慢落：起 0.5、落 0.14（落针加快一点，摆幅看起来更明显）
  s.l = targetL > s.l ? s.l + (targetL - s.l) * 0.55 : s.l + (targetL - s.l) * 0.18
  s.r = targetR > s.r ? s.r + (targetR - s.r) * 0.55 : s.r + (targetR - s.r) * 0.18
  s.pl = Math.max(s.l, s.pl - 0.006)
  s.pr = Math.max(s.r, s.pr - 0.006)

  // 两个表并排、整体居中，单表不超过 260px，免得面板很宽时表被拉扁
  const gap = 8
  const colW = Math.min(260, (w - gap - 16) / 2)
  const rail = (w - (colW * 2 + gap)) / 2
  paintMeter(ctx, rail, 2, colW, h - 6, s.l, s.pl, dial, needle, dim, hot)
  paintMeter(ctx, rail + colW + gap, 2, colW, h - 6, s.r, s.pr, dial, needle, dim, hot)
}

/** 把左右时域数据算成 0..1 的 VU 位置（-20dB 到 +3dB）。 */
export function level(buf: Uint8Array, an: AnalyserNode, side: 'l' | 'r'): number {
  const size = Math.min(buf.length, an.fftSize)
  an.getByteTimeDomainData(buf.subarray(0, size))
  let sum = 0
  for (let i = 0; i < size; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / size)
  const db = 20 * Math.log10(rms > 0 ? rms : 1e-7) // 约 -140..0
  // 数字音频里 -20dBFS 大致对应传统 VU 的 0，音乐播放常在 -20~-12 之间，
  // 按 -20..+3 映射的话指针只会在前三分之一小幅抖动。这里把窗口下移到
  // -30..-2，再取 0.7 次幂压缩：低电平被抬起来，指针就不会一直贴着
  // 表盘最左边，弱歌弱段的摆动也能看得出来。
  // 注意：静音时 db 会到 -140，比值是负数，负数开小数次幂是 NaN，
  // 指针会整根画不出来，所以先夹到 0。
  const pos = Math.pow(Math.max(0, (db + 30) / 28), 0.7)
  if (side === 'l' || side === 'r') return Math.max(0, Math.min(1, pos))
  return 0
}

/** 单只表：刻度弧 + 指针 + 峰值小三角。 */
export function paintMeter(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  v: number, peak: number,
  dial: string, needle: string, dim: string, hot: string,
) {
  const cx = x + w / 2
  const cy = y + h - 7
  const r = Math.min(w / 2 - 12, h * 0.74)
  if (r < 8) return
  const a0 = Math.PI * (-0.78)
  const a1 = Math.PI * (-0.22)
  // 0dB 落在整段刻度的哪里（刻度是 -20dB..+3dB）
  const over = 20 / 23

  // 表盘面：淡色扇形
  ctx.fillStyle = dial
  ctx.globalAlpha = 0.09
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.arc(cx, cy, r, a0, a1)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1

  // 弧
  ctx.strokeStyle = dial
  ctx.globalAlpha = 0.7
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.arc(cx, cy, r, a0, a1)
  ctx.stroke()

  // 0dB 以上的红区
  ctx.strokeStyle = hot
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.arc(cx, cy, r, a0 + (a1 - a0) * over, a1)
  ctx.stroke()
  ctx.globalAlpha = 1

  // 刻度
  ctx.strokeStyle = dim
  ctx.lineWidth = 1
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    const a = a0 + (a1 - a0) * t
    const major = i === 0 || i === 4 || i === 8
    ctx.globalAlpha = major ? 0.9 : 0.5
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * (r - (major ? 5 : 3)), cy + Math.sin(a) * (r - (major ? 5 : 3)))
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // 峰值小三角
  const ap = a0 + (a1 - a0) * peak
  ctx.fillStyle = hot
  const px = cx + Math.cos(ap) * (r - 6)
  const py = cy + Math.sin(ap) * (r - 6)
  ctx.beginPath()
  ctx.arc(px, py, 1.8, 0, Math.PI * 2)
  ctx.fill()

  // 指针
  const a = a0 + (a1 - a0) * v
  ctx.strokeStyle = needle
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(a) * (r - 1.5), cy + Math.sin(a) * (r - 1.5))
  ctx.stroke()

  // 轴心
  ctx.fillStyle = dial
  ctx.beginPath()
  ctx.arc(cx, cy, 2.4, 0, Math.PI * 2)
  ctx.fill()
}
