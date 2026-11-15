/* 十段均衡器：把 <audio> 接进 Web Audio，串 10 个 peaking 滤波器。

   注意事项：
   - createMediaElementSource 一旦调用就不可撤销，音频此后只从 AudioContext 出声，
     所以接入前先探一次 CORS（代理没给跨源头就会变成静音，那是最难查的坑）。
   - 均衡器「关闭」不是拆链路，而是把各段增益推 0、前置增益回 1，听感等价于旁路，
     但避免反复重建音频图。
*/

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export type EqPreset = { name: string; gains: number[] }

export const EQ_PRESETS: EqPreset[] = [
  { name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '流行', gains: [-1, 0, 2, 3, 2, 0, -1, -1, 0, 0] },
  { name: '摇滚', gains: [3, 3, 1, 0, -1, 0, 1, 2, 3, 2] },
  { name: '爵士', gains: [2, 1, 0, -1, -1, 0, 1, 2, 3, 3] },
  { name: '古典', gains: [0, 1, 2, 2, 1, 0, -1, -1, 0, 1] },
  { name: '人声', gains: [-2, -1, 0, 2, 4, 4, 3, 1, -1, -2] },
  { name: '低音加重', gains: [5, 4, 3, 2, 0, 0, 0, 0, 0, 0] },
]

export class Equalizer {
  private ac: AudioContext | null = null
  private src: MediaElementAudioSourceNode | null = null
  private preamp: GainNode | null = null
  private filters: BiquadFilterNode[] = []
  private out: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private anL: AnalyserNode | null = null
  private anR: AnalyserNode | null = null
  private enabled = false
  private gains = EQ_FREQS.map(() => 0)
  private preampValue = 1

  get ready() {
    return !!this.ac && !!this.src
  }

  get isEnabled() {
    return this.enabled
  }

  /** 可视化用的分析节点：混音、左、右。图没建好就是 null。 */
  get analysts(): { mixed: AnalyserNode; l: AnalyserNode; r: AnalyserNode } | null {
    if (!this.analyser || !this.anL || !this.anR) return null
    return { mixed: this.analyser, l: this.anL, r: this.anR }
  }

  /** 探测当前音源是否允许跨源读取，避免接上 WebAudio 后整条音频变静音。 */
  private async probeAudio(url: string): Promise<boolean> {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return true
    try {
      const res = await fetch(url, { method: 'GET', mode: 'cors', headers: { Range: 'bytes=0-1' } })
      return res.ok || res.status === 206
    } catch {
      return false
    }
  }

  /** 建立音频图。返回 false 表示当前音源不支持（跨源或浏览器限制）。 */
  async attach(el: HTMLAudioElement): Promise<boolean> {
    if (this.ac && this.src) return true
    const url = el.currentSrc || el.src
    if (!(await this.probeAudio(url))) return false
    try {
      // 跨源音频必须显式声明，否则 MediaElementSource 视为污染源，输出变静音
      if (el.crossOrigin !== 'anonymous') el.crossOrigin = 'anonymous'
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return false
      const ac: AudioContext = new AC()
      const src = ac.createMediaElementSource(el)
      const preamp = ac.createGain()
      preamp.gain.value = this.preampValue
      const filters = EQ_FREQS.map((f, i) => {
        const node = ac.createBiquadFilter()
        node.type = 'peaking'
        node.frequency.value = f
        node.Q.value = 1.1
        node.gain.value = this.gains[i] || 0
        return node
      })
      const out = ac.createGain()
      out.gain.value = 1

      src.connect(preamp)
      let last: AudioNode = preamp
      filters.forEach((f) => {
        last.connect(f)
        last = f
      })
      last.connect(out)
      out.connect(ac.destination)

      // 可视化旁路：analyser 只做读取，不接 destination，所以不影响出声。
      const analyser = ac.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.82
      out.connect(analyser)
      const splitter = ac.createChannelSplitter(2)
      out.connect(splitter)
      const anL = ac.createAnalyser()
      const anR = ac.createAnalyser()
      anL.fftSize = 1024
      anR.fftSize = 1024
      splitter.connect(anL, 0)
      splitter.connect(anR, 1)

      this.ac = ac
      this.src = src
      this.preamp = preamp
      this.filters = filters
      this.out = out
      this.analyser = analyser
      this.splitter = splitter
      this.anL = anL
      this.anR = anR
      await this.resume()
      return true
    } catch {
      this.ac = null
      this.src = null
      return false
    }
  }

  async resume() {
    if (this.ac && this.ac.state === 'suspended') {
      try {
        await this.ac.resume()
      } catch {
        /* 交给下一次用户手势 */
      }
    }
  }

  setGains(g: number[]) {
    this.gains = g.slice(0, EQ_FREQS.length)
    this.apply()
  }

  setPreamp(v: number) {
    this.preampValue = v
    this.apply()
  }

  setEnabled(v: boolean) {
    this.enabled = v
    this.apply()
  }

  private apply() {
    if (!this.ac) return
    const on = this.enabled
    this.filters.forEach((f, i) => {
      f.gain.value = on ? Math.max(-24, Math.min(24, this.gains[i] || 0)) : 0
    })
    if (this.preamp) this.preamp.gain.value = on ? this.preampValue : 1
  }

  dispose() {
    try {
      this.anL?.disconnect()
      this.anR?.disconnect()
      this.splitter?.disconnect()
      this.analyser?.disconnect()
      this.out?.disconnect()
      this.filters.forEach((f) => f.disconnect())
      this.preamp?.disconnect()
      this.src?.disconnect()
      this.ac?.close()
    } catch {
      /* 忽略 */
    }
    this.ac = null
    this.src = null
    this.filters = []
    this.preamp = null
    this.out = null
    this.analyser = null
    this.splitter = null
    this.anL = null
    this.anR = null
  }
}
