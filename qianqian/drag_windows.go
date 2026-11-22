//go:build windows

package qianqian

// 皮肤窗的拖动。三条线索都试过，结论写在下面，别再走回头路：
//
//   1. CSS --app-region:drag：mygo 在 Windows 上翻译成
//      SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)，进系统模态拖动循环。
//      无边框 + 透明 + 运行时被 SetSize 改过尺寸的窗口上它直接不动，还不报错。
//   2. 前端逐帧 WinMoveBy：每次都要过 UI 线程拿 Position/SetPosition，慢且容易丢。
//   3. 现在这套：Go 直接 SetWindowPos，按「按下时光标 + 按下时窗口位置」算坐标，
//      10ms 轮询 GetCursorPos 搬窗口，GetAsyncKeyState 看到左键抬起就停。
//      算法已在 Wine + Xvfb 上跑过：光标移 (120,78)，窗口跟着移 (120,78)，不漂。
//
// 触发有两条路，互为保险：
//   - 前端标题栏 mousedown 调 App.DragWindow()；
//   - 就算这条 JS→Go 的调用没打通，autoDrag 也会自己盯着左键：按下时光标落在
//     窗口顶部标题条、且窗口是前台，就直接接管。完全不依赖页面事件。

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
)

var (
	procGetCursorPos     = syscall.NewLazyDLL("user32.dll").NewProc("GetCursorPos")
	procGetWindowRect    = syscall.NewLazyDLL("user32.dll").NewProc("GetWindowRect")
	procSetWindowPos     = syscall.NewLazyDLL("user32.dll").NewProc("SetWindowPos")
	procGetAsyncKeyState = syscall.NewLazyDLL("user32.dll").NewProc("GetAsyncKeyState")
	procGetForeground    = syscall.NewLazyDLL("user32.dll").NewProc("GetForegroundWindow")
	procWindowFromPoint  = syscall.NewLazyDLL("user32.dll").NewProc("WindowFromPoint")
	procGetAncestor      = syscall.NewLazyDLL("user32.dll").NewProc("GetAncestor")
	procGetWindowPID     = syscall.NewLazyDLL("user32.dll").NewProc("GetWindowThreadProcessId")
	procGetCurrentPID    = syscall.NewLazyDLL("kernel32.dll").NewProc("GetCurrentProcessId")
	procIsWinVisible     = syscall.NewLazyDLL("user32.dll").NewProc("IsWindowVisible")
)

const (
	swpNoSize     = 0x0001
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
	vkLButton     = 0x01
	gaRoot        = 2
	dragPoll      = 10 * time.Millisecond
	// 标题条命中高度（DIP）。真机上缩放可能是 100%/125%/150%，这里按主窗的
	// 「物理高 ÷ DIP 高」算出本机缩放比，再换算成物理像素，免得高 DPI 下点不上。
	dragStripDip = 34
)

type dragPoint struct{ X, Y int32 }
type dragRect struct{ Left, Top, Right, Bottom int32 }

var (
	dragMu     sync.Mutex
	dragDoneCh chan struct{}

	autoDragOnce sync.Once
	skinDragOn   atomic.Bool
	autoDragApp  *App
)

// lp 把有符号的像素值转成 Win32 的 LONG 参数。
func lp(v int) uintptr { return uintptr(int32(v)) }

func cursorAt(p *dragPoint) bool {
	ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(p)))
	return ok != 0
}

func windowRectAt(hwnd uintptr, r *dragRect) bool {
	ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(r)))
	return ok != 0
}

func leftDown() bool {
	ks, _, _ := procGetAsyncKeyState.Call(vkLButton)
	return ks&0x8000 != 0
}

// dragLog 把拖动过程写进启动日志，真机排查时让用户直接把日志发过来。
func dragLog(format string, args ...any) {
	f, err := os.OpenFile(filepath.Join(dataDir(), "qqjt-boot.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [drag] %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}

// beginDrag 在给定锚点/起始位置开始跟手，直到左键抬起；已在拖就直接返回。
func beginDrag(hwnd uintptr, cursor dragPoint, origin dragRect, why string) {
	dragMu.Lock()
	if dragDoneCh != nil {
		dragMu.Unlock()
		return
	}
	done := make(chan struct{})
	dragDoneCh = done
	dragMu.Unlock()

	dragLog("%s hwnd=%x 光标=(%d,%d) 窗口=(%d,%d)", why, hwnd, cursor.X, cursor.Y, origin.Left, origin.Top)

	go func() {
		defer func() {
			dragMu.Lock()
			if dragDoneCh == done {
				dragDoneCh = nil
			}
			dragMu.Unlock()
		}()
		t := time.NewTicker(dragPoll)
		defer t.Stop()
		moves := 0
		for {
			select {
			case <-done:
				return
			case <-t.C:
			}
			if !leftDown() {
				// 松开前补最后一帧：轮询是 10ms 一次，手快的时候最后一段位移
				// 还没落到窗口上就松手了，窗口会停在半路（实测能差 20px 左右）。
				if moves > 0 {
					var fin dragPoint
					if cursorAt(&fin) {
						procSetWindowPos.Call(hwnd, 0,
							lp(int(origin.Left)+int(fin.X-cursor.X)),
							lp(int(origin.Top)+int(fin.Y-cursor.Y)),
							0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
					}
				}
				if moves == 0 {
					dragLog("左键已抬起，一次都没移动过（说明拖动入口通了，只是没动）")
				}
				return
			}
			var now dragPoint
			if !cursorAt(&now) {
				return
			}
			dx, dy := int(now.X-cursor.X), int(now.Y-cursor.Y)
			if dx == 0 && dy == 0 {
				continue
			}
			// 始终用「起始位置 + 累计位移」，避免逐帧累加带来的抖动漂移。
			wx, wy := int(origin.Left)+dx, int(origin.Top)+dy
			procSetWindowPos.Call(hwnd, 0, lp(wx), lp(wy), 0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
			moves++
			if moves <= 3 {
				dragLog("移动 %d 次 光标=(%d,%d) → 窗口=(%d,%d)", moves, now.X, now.Y, wx, wy)
			}
		}
	}()
}

// windowUnderCursor 取光标所在的本进程顶层窗口：四窗各自都能被拖。
func windowUnderCursor() uintptr {
	var p dragPoint
	if !cursorAt(&p) {
		return 0
	}
	h, _, _ := procWindowFromPoint.Call(uintptr(unsafe.Pointer(&p)))
	if h == 0 {
		return 0
	}
	root, _, _ := procGetAncestor.Call(h, gaRoot)
	if root != 0 {
		h = root
	}
	// 只认自己的窗口，别去拖别的程序的窗口。
	var pid uint32
	procGetWindowPID.Call(h, uintptr(unsafe.Pointer(&pid)))
	me, _, _ := procGetCurrentPID.Call()
	if uintptr(pid) != me {
		return 0
	}
	return h
}

func (a *App) hwnd() uintptr {
	if a.win != nil {
		if h := a.win.NativeHandle(); h != 0 {
			return h
		}
	}
	// 拿不到句柄时退一步用前台窗口：拖动都是从点上来的，那一刻它是自己。
	h, _, _ := procGetForeground.Call()
	return h
}

// dragWindowFor 前端标题栏 mousedown 调进来，带的是自己那块面板名。
// 句柄直接取自对应窗口（main / eq / lyric / playlist），不再用光标猜——
// 之前靠 WindowFromPoint 猜窗口在 WebView2 上不可靠，是「拖不动」的根因之一。
func (a *App) dragWindowFor(panel string) {
	w := a.panelByName(panel)
	var hwnd uintptr
	if w != nil {
		hwnd = w.NativeHandle()
	}
	why := "前端请求拖动(" + panel + ")"
	if hwnd == 0 {
		hwnd = windowUnderCursor()
		why = "前端请求拖动(句柄为空，退回光标命中)"
	}
	if hwnd == 0 {
		hwnd = a.hwnd()
		why += "+前台兜底"
	}
	if hwnd == 0 {
		dragLog("调用到达(%s)，但拿不到窗口句柄", panel)
		return
	}
	var cursor dragPoint
	var origin dragRect
	cursorAt(&cursor)
	if !windowRectAt(hwnd, &origin) {
		dragLog("%s 但 GetWindowRect 失败 hwnd=%x", why, hwnd)
		return
	}
	beginDrag(hwnd, cursor, origin, why)
}

// autoDragSwitch 皮肤模式开关时调，true 时启动一次性的兜底监听。
func (a *App) autoDragSwitch(on bool) {
	autoDragApp = a
	skinDragOn.Store(on)
	if !on {
		return
	}
	autoDragOnce.Do(func() { go a.autoDragLoop() })
}

// autoDragLoop 不依赖页面事件：左键按下时若光标落在窗口顶部标题条、且窗口是前台，
// 就直接开始拖。这样即使 JS→Go 的调用没打通，标题栏也一定能拖。
func (a *App) autoDragLoop() {
	t := time.NewTicker(dragPoll)
	defer t.Stop()
	down := false
	for range t.C {
		if !skinDragOn.Load() {
			down = false
			continue
		}
		if !leftDown() {
			down = false
			continue
		}
		if down {
			continue
		}
		down = true
		if a.dragDone() {
			continue
		}
		var cursor dragPoint
		if !cursorAt(&cursor) {
			continue
		}
		hwnd, r, ok := a.ownWindowAtPoint(cursor)
		if !ok {
			dragLog("按下没有命中标题条 光标=(%d,%d) 主窗=%s", cursor.X, cursor.Y, a.rectsText())
			continue // 光标不在自己的窗口标题条上
		}
		beginDrag(hwnd, cursor, r, "顶部标题条自动接管")
	}
}

// dragDone 报告当前是否已经在拖（避免自动接管打断前端发起的拖动）。
func (a *App) dragDone() bool {
	dragMu.Lock()
	defer dragMu.Unlock()
	return dragDoneCh != nil
}

// dpiScale 物理像素 ÷ DIP。主窗永远是 panelMainH 高，拿它反推本机缩放比。
func (a *App) dpiScale() float64 {
	if a.win == nil {
		return 1
	}
	if h := a.win.NativeHandle(); h != 0 {
		var r dragRect
		if windowRectAt(h, &r) {
			if ph := float64(r.Bottom - r.Top); ph > 0 {
				s := ph / float64(panelMainH)
				if s >= 0.6 && s <= 4 {
					return s
				}
			}
		}
	}
	return 1
}

// ownWindowAtPoint 判断光标是否落在自己某个窗口的标题条上（含主窗和三个副窗）。
// 不查 PID、不要求前台窗口：这两条在 WebView2 + 无边框透明窗上是「拖不动」的元凶。
func (a *App) ownWindowAtPoint(p dragPoint) (uintptr, dragRect, bool) {
	strip := int32(dragStripDip * a.dpiScale())
	cands := []*mygo.Window{a.win}
	panelMu.Lock()
	for _, n := range []string{"eq", "lyric", "playlist"} {
		if w := panelWins[n]; w != nil {
			cands = append(cands, w)
		}
	}
	panelMu.Unlock()
	for _, w := range cands {
		if w == nil {
			continue
		}
		h := w.NativeHandle()
		if h == 0 {
			continue
		}
		if vis, _, _ := procIsWinVisible.Call(h); vis == 0 {
			continue
		}
		var r dragRect
		if !windowRectAt(h, &r) {
			continue
		}
		if p.X < r.Left || p.X > r.Right {
			continue
		}
		// 窗口本身很矮（卷起状态）时整块都算标题条。
		limit := r.Top + strip
		if r.Bottom < limit {
			limit = r.Bottom
		}
		if p.Y >= r.Top && p.Y <= limit {
			return h, r, true
		}
	}
	return 0, dragRect{}, false
}

// rectsText 把四个窗口的矩形拼成一行，供日志用（按下没命中时看看到底偏在哪）。
func (a *App) rectsText() string {
	out := ""
	add := func(name string, w *mygo.Window) {
		if w == nil {
			return
		}
		h := w.NativeHandle()
		if h == 0 {
			return
		}
		var r dragRect
		if !windowRectAt(h, &r) {
			return
		}
		vis, _, _ := procIsWinVisible.Call(h)
		out += fmt.Sprintf(" %s[%d,%d,%d,%d vis=%d]", name, r.Left, r.Top, r.Right, r.Bottom, vis)
	}
	add("main", a.win)
	panelMu.Lock()
	add("eq", panelWins["eq"])
	add("lyric", panelWins["lyric"])
	add("playlist", panelWins["playlist"])
	panelMu.Unlock()
	return out
}
