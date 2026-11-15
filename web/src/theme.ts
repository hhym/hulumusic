/* 主题：浅色 / 深色 / 橘黄三档。配色变量都在 style.css 的 [data-theme] 里。
   桌面、皮肤、迷你三个界面共用这一套，皮肤界面通过「皮肤 ↔ 主题」映射保持视觉一致。 */
export type Theme = 'dark' | 'light' | 'amber'

export const THEME_LABEL: Record<Theme, string> = {dark: '深色', light: '浅色', amber: '橘黄'}
export const THEME_ICON: Record<Theme, string> = {dark: '☾', light: '☀', amber: '◐'}
// 侧栏那个小按钮点一下换下一个：浅 → 深 → 橘黄 → 浅
export const NEXT_THEME: Record<Theme, Theme> = {light: 'dark', dark: 'amber', amber: 'light'}
