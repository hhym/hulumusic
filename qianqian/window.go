package qianqian

import "github.com/egoist/mygo"

// 迷你浮卡：窗口缩成 348x124 并置顶。MyGo 的窗口是透明无边框的，
// 圆角与阴影交给页面里的 CSS（.mini-card / .mini-player），不再像
// Win32 那版那样用 SetWindowRgn 裁轮廓。

const (
	miniW, miniH = 348, 124
	deskW, deskH = 1190, 780
	// 主界面的最小尺寸。窗口创建时按这个下限建，缩迷你之前必须先放开，
	// 否则 SetSize(348,124) 会被系统按 900x560 夹住 —— 结果就是迷你卡
	// 孤零零贴在左上角、窗口还是原来那么大。
	minW, minH = 900, 560
	// 抓左右边缘能拉多宽。上限按 4K 屏的 3/4 留余量，再宽不如直接最大化。
	maxW = 2600
)

// ToggleMax 在「铺满屏幕工作区」和「回到原来的位置尺寸」之间切换。
// MyGo 的窗口是无边框的，没有系统标题栏那个最大化按钮可用，所以自己算：
// 最大化就是把客户区摆成 PrimaryDisplay 的工作区（不含任务栏），
// 还原就把进最大化之前记下的 x/y/w/h 原样盖回去。
// 返回值是切换之后是否处于最大化状态，前端拿它换图标。
func (a *App) ToggleMax() bool {
	if a.win == nil {
		return false
	}
	if a.maxed {
		x, y, w, h := a.restore[0], a.restore[1], a.restore[2], a.restore[3]
		if w > 0 && h > 0 {
			a.win.SetBounds(mygo.Rectangle{X: x, Y: y, Width: w, Height: h})
		}
		a.win.SetMinimumSize(minW, minH)
		a.maxed = false
		return false
	}
	x, y := a.win.Position()
	w, h := a.win.Size()
	a.restore = [4]int{x, y, w, h}
	wa := mygo.Screen.PrimaryDisplay().WorkArea
	if wa.Width <= 0 || wa.Height <= 0 {
		return false
	}
	a.win.SetMinimumSize(0, 0) // 屏幕比 minW 还小时不能被夹住
	a.win.SetBounds(wa)
	a.maxed = true
	return true
}

// MiniWidth, MiniHeight 是迷你卡片的窗口尺寸。宿主（原生
// 界面）要另外开一个迷你窗口时照这个开，和前端 .mini-player 的尺寸对上。
func MiniWidth() int  { return miniW }
func MiniHeight() int { return miniH }

func (a *App) miniOn() string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	if a.maxed {
		a.maxed = false
		a.restore[2], a.restore[3] = deskW, deskH
	}
	a.win.SetMinimumSize(0, 0)
	a.win.SetSize(miniW, miniH)
	a.win.SetAlwaysOnTop(true)
	return ""
}

func (a *App) miniOff() string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	a.win.SetAlwaysOnTop(false)
	a.win.SetSize(deskW, deskH)
	a.win.SetMinimumSize(minW, minH)
	return ""
}

// Wails 那版叫 WinMoveBy；这里做同样的换算，给页面拖动迷你卡用。
func (a *App) WinMoveBy(dx, dy int) string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	x, y := a.win.Position()
	a.win.SetPosition(x+dx, y+dy)
	return ""
}

// ResizeEdge 给页面自绘的左右拖边用：dir 是 "left" / "right"，w 是目标窗口宽度。
// 拖左边时窗口的 x 要跟着挪，右边保持不动 —— 所以先 SetPosition 再 SetSize。
// 高度一直不动，宽度夹在 minW..maxW 之间。
func (a *App) ResizeEdge(w int, dir string) string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	if a.maxed {
		return "" // 最大化状态下拖边没有意义，先还原再来
	}
	if w < minW {
		w = minW
	}
	if w > maxW {
		w = maxW
	}
	cw, h := a.win.Size()
	x, y := a.win.Position()
	if dir == "left" && cw != w {
		a.win.SetPosition(x+(cw-w), y)
	}
	a.win.SetSize(w, h)
	return ""
}
