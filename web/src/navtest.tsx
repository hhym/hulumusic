import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'

const stations = [
  {id:'radio:qt_pop', name:'华语流行台', desc:'蜻蜓FM · 华语流行直播', region:'中国', logo:''},
  {id:'cloud:639', name:'中国之声', desc:'云听 · 央广', region:'中国', logo:''},
]
const plugins = [{id:'bilibili', name:'Bilibili', kind:'music', enabled:true, author:'', version:'1'}]
const stub: any = new Proxy({}, {
  get: (_t, k: string) => (...args: any[]) => {
    if (k === 'Stations') return [stations, null]
    if (k === 'Plugins') return [plugins, null]
    if (k === 'LocalDirs') return []
    if (k === 'SkipPlaylists') return [[], null]
    if (k === 'PageURL') return ''
    return [{}, null]
  },
})
;(window as any).go = {main: {App: stub}}
;localStorage.setItem('qqjt-layout', 'desk')
window.addEventListener('error', (e) => { document.body.insertAdjacentHTML('beforeend', '<pre style="padding:10px;font:12px monospace;color:#c0392b">ERR '+String(e.message)+'\n'+String((e as any).error?.stack||'')+'</pre>') })
window.addEventListener('unhandledrejection', (e) => { document.body.insertAdjacentHTML('beforeend', '<pre style="padding:10px;font:12px monospace;color:#8e44ad">REJ '+String((e as any).reason)+'</pre>') })
createRoot(document.getElementById('root')!).render(<App />)
