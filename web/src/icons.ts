/* 应用图标（设置页「图标」那两排）。
   classic = 千千静听新图标（也是 exe 自带），neon / sunset 是早期两套，
   其余 11 套跟配色主题一一对应，id 直接用主题 key。
   窗口 / 任务栏图标由 Go 的 SetAppIcon 走 Win32 WM_SETICON 换，
   这里只管界面里显示哪张图。 */
import classic from './assets/images/icon-classic.png'
import neon from './assets/images/icon-neon.png'
import sunset from './assets/images/icon-sunset.png'
import retroBrown from './assets/images/icon-retro-brown.png'
import retroBrass from './assets/images/icon-retro-brass.png'
import retroWine from './assets/images/icon-retro-wine.png'
import cyberViolet from './assets/images/icon-cyber-violet.png'
import cyberDusk from './assets/images/icon-cyber-dusk.png'
import cyberRose from './assets/images/icon-cyber-rose.png'
import mistBlue from './assets/images/icon-mist-blue.png'
import sageGreen from './assets/images/icon-sage-green.png'
import oatBeige from './assets/images/icon-oat-beige.png'
import kleinBlue from './assets/images/icon-klein-blue.png'
import tomatoIndigo from './assets/images/icon-tomato-indigo.png'

export const ICON_SRC: Record<string, string> = {
  classic,
  neon,
  sunset,
  'retro-brown': retroBrown,
  'retro-brass': retroBrass,
  'retro-wine': retroWine,
  'cyber-violet': cyberViolet,
  'cyber-dusk': cyberDusk,
  'cyber-rose': cyberRose,
  'mist-blue': mistBlue,
  'sage-green': sageGreen,
  'oat-beige': oatBeige,
  'klein-blue': kleinBlue,
  'tomato-indigo': tomatoIndigo,
}

export const ICON_LABEL: Record<string, string> = {
  classic: '经典',
  neon: '霓虹',
  sunset: '暖橙',
  'retro-brown': '暖褐复古',
  'retro-brass': '墨绿黄铜',
  'retro-wine': '酒红米白',
  'cyber-violet': '深紫霓虹',
  'cyber-dusk': '午夜青橙',
  'cyber-rose': '电光玫红',
  'mist-blue': '雾蓝岩灰',
  'sage-green': '鼠尾草绿',
  'oat-beige': '燕麦米杏',
  'klein-blue': '克莱因蓝',
  'tomato-indigo': '番茄靛蓝',
}

// 第一排三套常用，第二排跟 11 套配色主题对应
export const ICON_TOP = ['classic', 'neon', 'sunset'] as const
export const ICON_THEME_KEYS = [
  'retro-brown', 'retro-brass', 'retro-wine',
  'cyber-violet', 'cyber-dusk', 'cyber-rose',
  'mist-blue', 'sage-green', 'oat-beige',
  'klein-blue', 'tomato-indigo',
]

export const isIconId = (v: unknown): v is string => typeof v === 'string' && v in ICON_SRC

export function iconSrc(id: string): string {
  return ICON_SRC[id] || classic
}
