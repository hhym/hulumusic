//go:build windows

package qianqian

// 皮肤窗的拖动：不走 CSS 的拖动区，也不走前端逐帧 WinMoveBy，而是直接
// 用 Win32 的 GetCursorPos + SetWindowPos 跟着鼠标走。
// 原因：宿主 mygo 的 --app-region:drag 在 Windows 上最终是
// SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)，进入系统自带的模态拖动循环，
// 在这种无边框 + 透明 + 运行时改过尺寸的窗口上容易一脚踩空；而前端的
// WinMoveBy 每次都要过一遍 UI 线程，逐帧调用又慢又容易被丢弃。这里按下标题
// 栏时开一个 10ms 的轮询 goroutine，按光标位移直接 SetWindowPos，松开左键
// （GetAsyncKeyState 看到抬起）就停。

import (
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	procGetCursorPos     = syscall.NewLazyDLL("user32.dll").NewProc("GetCursorPos")
	procGetWindowRect    = syscall.NewLazyDLL("user32.dll").NewProc("GetWindowRect")
	procSetWindowPos     = syscall.NewLazyDLL("user32.dll").NewProc("SetWindowPos")
	procGetAsyncKeyState = syscall.NewLazyDLL("user32.dll").NewProc("GetAsyncKeyState")
)

const (
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
	vkLButton     = 0x01
	dragPoll      = 10 * time.Millisecond
)

type dragPoint struct{ X, Y int32 }
type dragRect struct{ Left, Top, Right, Bottom int32 }

var (
	dragMu   sync.Mutex
	dragDone chan struct{}
)

// lp 把有符号的像素值转成 Win32 的 LONG 参数。
func lp(v int) uintptr { return uintptr(int32(v)) }

// dragWindow 以当前光标为锚点开始拖动窗口，直到左键抬起。
func (a *App) dragWindow() {
	if a.win == nil {
		return
	}
	hwnd := a.win.NativeHandle()
	if hwnd == 0 {
		return
	}

	dragMu.Lock()
	if dragDone != nil { // 已经在拖，忽略重复按下
		dragMu.Unlock()
		return
	}
	done := make(chan struct{})
	dragDone = done
	dragMu.Unlock()

	var cursor dragPoint
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor)))
	var origin dragRect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&origin)))

	go func() {
		defer func() {
			dragMu.Lock()
			if dragDone == done {
				dragDone = nil
			}
			dragMu.Unlock()
		}()
		t := time.NewTicker(dragPoll)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
			}
			ks, _, _ := procGetAsyncKeyState.Call(vkLButton)
			if ks&0x8000 == 0 {
				return
			}
			var now dragPoint
			if ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&now))); ok == 0 {
				return
			}
			dx, dy := int(now.X-cursor.X), int(now.Y-cursor.Y)
			if dx == 0 && dy == 0 {
				continue
			}
			// 始终用「起始位置 + 累计位移」，避免逐帧累加带来的抖动漂移。
			procSetWindowPos.Call(hwnd, 0,
				lp(int(origin.Left)+dx), lp(int(origin.Top)+dy),
				0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
		}
	}()
}
