//go:build !windows

package qianqian

// applyWindowIcon 非 Windows 平台没有 Windows 的窗口图标接口，界面里的 logo 仍会切换。
func applyWindowIcon(string) {}
