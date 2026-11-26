/* 主题：6 档经典 + 11 套配色主题（2026-11-26 新增）。
   经典档的变量是手调的；配色主题只给「主色 / 背景 / 文字 / 点缀」四色，
   面板、边框、悬停、选中、进度条底色等全部由这四色按明度关系派生，
   所以切过去是整套界面联动的一套色，而不是只换一个主色。变量都在 style.css 的 [data-theme] 里。
   桌面、皮肤、迷你三个界面共用这一套，皮肤界面通过「皮肤 ↔ 主题」映射保持视觉一致。 */
export type Theme = 'dark' | 'light' | 'amber' | 'teal' | 'green' | 'neon'
  | 'retro-brown' | 'retro-brass' | 'retro-wine'
  | 'cyber-violet' | 'cyber-dusk' | 'cyber-rose'
  | 'mist-blue' | 'sage-green' | 'oat-beige'
  | 'klein-blue' | 'tomato-indigo'

export const THEME_LABEL: Record<Theme, string> = {
  dark: '深色', light: '浅色', amber: '橘黄', teal: '深青', green: '护眼绿', neon: '霓虹紫',
  'retro-brown': '暖褐复古', 'retro-brass': '墨绿黄铜', 'retro-wine': '酒红米白',
  'cyber-violet': '深紫霓虹', 'cyber-dusk': '午夜青橙', 'cyber-rose': '电光玫红',
  'mist-blue': '雾蓝岩灰', 'sage-green': '鼠尾草绿', 'oat-beige': '燕麦米杏',
  'klein-blue': '克莱因蓝', 'tomato-indigo': '番茄靛蓝',
}
export const THEME_ICO = {
  dark: 'moon', light: 'sunny', amber: 'contrast', teal: 'aperture', green: 'flower', neon: 'flash',
  'retro-brown': 'contrast', 'retro-brass': 'flower', 'retro-wine': 'contrast',
  'cyber-violet': 'flash', 'cyber-dusk': 'flash', 'cyber-rose': 'flash',
  'mist-blue': 'aperture', 'sage-green': 'flower', 'oat-beige': 'sunny',
  'klein-blue': 'aperture', 'tomato-indigo': 'flash',
} as const
export const THEME_ICON: Record<Theme, string> = {
  dark: '☾', light: '☀', amber: '◐', teal: '❋', green: '✿', neon: '✦',
  'retro-brown': '❖', 'retro-brass': '❀', 'retro-wine': '✧',
  'cyber-violet': '◈', 'cyber-dusk': '◎', 'cyber-rose': '✷',
  'mist-blue': '◇', 'sage-green': '❁', 'oat-beige': '○',
  'klein-blue': '●', 'tomato-indigo': '✸',
}
// 侧栏那个小按钮点一下换下一档：浅 → 复古三套 → 低饱和三套 → 撞色两套 → 护眼绿 → 橘黄 → 深青 → 深色 → 赛博三套 → 霓虹紫 → 浅
export const NEXT_THEME: Record<Theme, Theme> = {
  light: 'retro-brown', 'retro-brown': 'retro-brass', 'retro-brass': 'retro-wine',
  'retro-wine': 'mist-blue', 'mist-blue': 'sage-green', 'sage-green': 'oat-beige',
  'oat-beige': 'klein-blue', 'klein-blue': 'tomato-indigo', 'tomato-indigo': 'green',
  green: 'amber', amber: 'teal', teal: 'dark', dark: 'cyber-violet',
  'cyber-violet': 'cyber-dusk', 'cyber-dusk': 'cyber-rose', 'cyber-rose': 'neon',
  neon: 'light',
}
export const THEME_KEYS = Object.keys(THEME_LABEL) as Theme[]
export const isTheme = (v: unknown): v is Theme => typeof v === 'string' && v in THEME_LABEL
