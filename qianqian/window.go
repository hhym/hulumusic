package qianqian

import "github.com/egoist/mygo"

// 迷你浮卡：窗口缩成 348x124 并置顶。MyGo 的窗口是透明无边框的，
// 圆角与阴影交给页面里的 CSS（.mini-card / .mini-player），不再像
// Win32 那版那样用 SetWindowRgn 裁轮廓。

const (
	miniW, miniH = 348, 124
	// 皮肤界面：竖向 480×1024 小窗。
	skinW, skinH = 480, 1024
	deskW, deskH = 1190, 780
	// 主界面的最小尺寸。窗口创建时按这个下限建，缩迷你之前必须先放开，
	// 否则 SetSize(348,124) 会被系统按 900x560 夹住 —— 结果就是迷你卡
	// 孤零零贴在左上角、窗口还是原来那么大。
	minW, minH = 460, 560
	// 抓左右边缘能拉多宽。上限按 4K 屏的 3/4 留余量，再宽不如直接最大化。
	maxW = 2600
)

// MiniWidth, MiniHeight 是迷你卡片的窗口尺寸。宿主（原生
// 界面）要另外开一个迷你窗口时照这个开，和前端 .mini-player 的尺寸对上。
func MiniWidth() int  { return miniW }
func MiniHeight() int { return miniH }

func (a *App) miniOn() string {
	if a.win == nil {
		return "窗口还没准备好"
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

// skinOn 切到竖向皮肤窗 480×1024：先放开最小尺寸下限，再改尺寸。
// 屏幕工作区装不下 1024 高时（小屏或高 DPI）按工作区收一下，否则窗口底部
// 会拖出屏幕外，页面又被裁掉一截。页面已按 100% 铺满，收高度只是压紧列表。
func (a *App) skinOn() string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	w, h := skinW, skinH
	if d := mygo.Screen.PrimaryDisplay(); d.WorkArea.Width > 0 && d.WorkArea.Height > 0 {
		if d.WorkArea.Width < w {
			w = d.WorkArea.Width
		}
		if d.WorkArea.Height < h {
			h = d.WorkArea.Height
		}
	}
	a.win.SetMinimumSize(0, 0)
	a.win.SetAlwaysOnTop(false)
	// 最大化状态下改尺寸会被系统吞掉，先把窗口还原回普通状态。
	if a.win.IsMaximized() {
		a.win.Unmaximize()
	}
	a.win.SetSize(w, h)
	// 打开顶部标题条的原生拖动兜底（只认皮肤模式）。
	a.autoDragSwitch(true)
	return ""
}

// skinOff 从皮肤窗还原到桌面主界面尺寸。
func (a *App) skinOff() string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	a.autoDragSwitch(false)
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

// FitWindowWidth 把窗口宽度改到 w（高度不动），页面关掉歌词秀时收成一列 320 用。
// w 小于最小宽度时会临时放开下限，宽度回到常规档时再恢复。
func (a *App) FitWindowWidth(w int) string {
	if a.win == nil {
		return "窗口还没准备好"
	}
	if w < 240 {
		w = 240
	}
	if w > maxW {
		w = maxW
	}
	if w >= minW {
		a.win.SetMinimumSize(minW, minH)
	} else {
		a.win.SetMinimumSize(0, 0)
	}
	_, h := a.win.Size()
	a.win.SetSize(w, h)
	return ""
}
