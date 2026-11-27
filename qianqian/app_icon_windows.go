//go:build windows

package qianqian

import (
	"os"
	"syscall"
	"unsafe"
)

const (
	wmSetIcon      = 0x0080
	iconSmallRes   = 0
	iconBigRes     = 1
	imageIcon      = 1
	lrLoadFromFile = 0x0010
)

var (
	kernelUser32          = syscall.NewLazyDLL("user32.dll")
	procEnumWindows       = kernelUser32.NewProc("EnumWindows")
	procGetWindowThreadID = kernelUser32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible   = kernelUser32.NewProc("IsWindowVisible")
	procGetWindowTextW    = kernelUser32.NewProc("GetWindowTextW")
	procSendMessageW      = kernelUser32.NewProc("SendMessageW")
	procLoadImageW        = kernelUser32.NewProc("LoadImageW")
)

// applyWindowIcon 把主窗口的标题栏 / 任务栏图标换成 icoPath；空串表示恢复 exe 自带图标。
// 返回 false 表示窗口还没出现（启动阶段要轮询重试）。
func applyWindowIcon(icoPath string) bool {
	hwnd := findOwnMainWindow()
	if hwnd == 0 {
		return false
	}
	var bigIcon, smallIcon uintptr
	if icoPath != "" {
		if p, err := syscall.UTF16PtrFromString(icoPath); err == nil {
			bigIcon, _, _ = procLoadImageW.Call(0, uintptr(unsafe.Pointer(p)),
				imageIcon, 48, 48, lrLoadFromFile)
			smallIcon, _, _ = procLoadImageW.Call(0, uintptr(unsafe.Pointer(p)),
				imageIcon, 16, 16, lrLoadFromFile)
		}
	}
	procSendMessageW.Call(hwnd, wmSetIcon, iconBigRes, bigIcon)
	procSendMessageW.Call(hwnd, wmSetIcon, iconSmallRes, smallIcon)
	return true
}

// findOwnMainWindow 返回本进程第一个可见窗口（Wails 的主窗口）。
func findOwnMainWindow() uintptr {
	pid := uint32(os.Getpid())
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadID.Call(hwnd, uintptr(unsafe.Pointer(&wpid)))
		if wpid == pid {
			v, _, _ := procIsWindowVisible.Call(hwnd)
			if v != 0 {
				var buf [256]uint16
				n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
				if n > 0 {
					found = hwnd
					return 0 // 找到就停
				}
			}
		}
		return 1 // 继续枚举
	})
	procEnumWindows.Call(cb, 0)
	return found
}
