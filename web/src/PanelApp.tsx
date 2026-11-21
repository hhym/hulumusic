import {useEffect, useState} from 'react'
import SkinView from './SkinView'

/* 经典四窗的副窗（均衡器 / 歌词秀 / 播放列表）。
   每个副窗是独立 WebView，自己不带播放器，状态由主窗推送过来：
   主窗调 App.SyncPush 广播，这里用 window.__huluRecv 接住；副窗上的操作
   反过来打包成命令，用 App.CmdSend 交回主窗执行。 */

type State = {
  cur: any
  playing: boolean
  busy: boolean
  pos: number
  dur: number
  lyric: {time: number; text: string}[]
  curIndex: number
  queue: {list: any[]; idx: number}
  volume: number
  eqGains: number[]
  eqOn: boolean
  eqPreset: number
  eqPresets: string[]
  shuffle: boolean
  inLib: boolean
  skin?: string
}

const EMPTY: State = {
  cur: null, playing: false, busy: false, pos: 0, dur: 0, lyric: [], curIndex: -1,
  queue: {list: [], idx: 0}, volume: 1, eqGains: [], eqOn: false, eqPreset: 0,
  eqPresets: [], shuffle: false, inLib: false, skin: 'purple',
}

const send = (cmd: Record<string, any>) => {
  try { (window as any).go?.main?.App?.CmdSend?.(JSON.stringify(cmd)) } catch { /* 忽略 */ }
}

export default function PanelApp({panel}: {panel: string}) {
  const [st, setSt] = useState<State>(EMPTY)

  useEffect(() => {
    ;(window as any).__huluRecv = (json: string) => {
      try { setSt({...EMPTY, ...JSON.parse(json)}) } catch { /* 忽略 */ }
    }
    return () => { try { delete (window as any).__huluRecv } catch { /* 忽略 */ } }
  }, [])

  return (
    <SkinView
      only={panel as any}
      skinName={st.skin}
      cur={st.cur}
      playing={st.playing}
      busy={st.busy}
      pos={st.pos}
      dur={st.dur}
      lyric={st.lyric || []}
      curIndex={st.curIndex}
      queue={st.queue || {list: [], idx: 0}}
      volume={st.volume}
      eqGains={st.eqGains || []}
      eqOn={st.eqOn}
      eqPreset={st.eqPreset}
      eqPresets={st.eqPresets || []}
      shuffle={st.shuffle}
      inLib={st.inLib}
      onToggle={() => send({t: 'toggle'})}
      onPrev={() => send({t: 'prev'})}
      onNext={() => send({t: 'next'})}
      onSeek={(ms) => send({t: 'seek', ms})}
      onVolume={(v) => send({t: 'volume', v})}
      onFav={() => send({t: 'fav'})}
      onPlayAt={(i) => send({t: 'playAt', i})}
      onEqToggle={() => send({t: 'eqToggle'})}
      onEqReset={() => send({t: 'eqReset'})}
      onEqPreset={(i) => send({t: 'eqPreset', i})}
      onShuffle={() => send({t: 'shuffle'})}
      onRemoveAt={(i) => send({t: 'removeAt', i})}
      onClearList={() => send({t: 'clearList'})}
      onClearNext={() => send({t: 'clearNext'})}
      onExpand={() => send({t: 'expand'})}
    />
  )
}
