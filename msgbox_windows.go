//go:build windows

package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

var procMessageBoxW = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

const (
	mbIconError = 0x00000010
	mbIconInfo  = 0x00000040
)

// showMessage 弹系统消息框。GUI 构建没有控制台，启动失败必须让用户看见原因，
// 否则表现就是"双击没反应"。
func showMessage(title, text string, isErr bool) {
	flags := uintptr(mbIconInfo)
	if isErr {
		flags = mbIconError
	}
	t, err1 := syscall.UTF16PtrFromString(title)
	m, err2 := syscall.UTF16PtrFromString(text)
	if err1 != nil || err2 != nil {
		return
	}
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
	runtime.KeepAlive(t)
	runtime.KeepAlive(m)
}
