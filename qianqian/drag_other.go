//go:build !windows

package qianqian

// 非 Windows 平台没有这套原生拖动，留空实现，保证交叉检查能编译。
func (a *App) dragWindow() {}
