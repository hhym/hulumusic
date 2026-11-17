/* 主题：浅色 / 护眼绿 / 橘黄 / 深青 / 深色五档。配色变量都在 style.css 的 [data-theme] 里。
   桌面、皮肤、迷你三个界面共用这一套，皮肤界面通过「皮肤 ↔ 主题」映射保持视觉一致。 */
export type Theme = 'dark' | 'light' | 'amber' | 'teal' | 'green' | 'neon'

export const THEME_LABEL: Record<Theme, string> = {dark: '深色', light: '浅色', amber: '橘黄', teal: '深青', green: '护眼绿', neon: '霓虹紫'}
export const THEME_ICO = {dark: 'moon', light: 'sunny', amber: 'contrast', teal: 'aperture', green: 'flower', neon: 'flash'} as const
export const THEME_ICON: Record<Theme, string> = {dark: '☾', light: '☀', amber: '◐', teal: '❋', green: '✿', neon: '✦'}
// 侧栏那个小按钮点一下换下一个：浅 → 护眼绿 → 橘黄 → 深青 → 深色 → 霓虹紫 → 浅
export const NEXT_THEME: Record<Theme, Theme> = {light: 'green', green: 'amber', amber: 'teal', teal: 'dark', dark: 'neon', neon: 'light'}
