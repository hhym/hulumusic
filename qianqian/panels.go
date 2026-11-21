package qianqian

// 经典四窗：主窗之外再开三个真正的窗口（均衡器 / 歌词秀 / 播放列表），
// 各自能单独拖动、单独折叠收起。四窗口叠成一列，尺寸都由这里统一算。
//
// 三个副窗加载的是同一个页面，只是带 ?panel=eq / lyric / playlist，
// 前端按参数只画那一个面板；播放状态由主窗推送过来（SyncPush / CmdSend）。

import (
	"fmt"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

const (
	panelMainH  = 352 // 主窗（标题栏 + 色板 + 播放面板）
	panelEqH    = 126
	panelLyricH = 216
	panelGap    = 4
	panelMinPl  = 220
	panelMaxPl  = 420
	panelBarH   = 26 // 折叠成一条标题栏时的高度
)

var panelMu sync.Mutex
var panelWins map[string]*mygo.Window
// panelPlaced 记录这一轮皮肤界面是否已经排过位置，免得重新打开副窗时
// 又把用户拖走的窗口拽回原位。
var panelPlaced bool

func newWinSafe(opts mygo.WindowOptions) (win *mygo.Window, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return mygo.NewWindow(opts), nil
}

// buildPanels 在主线程上建三个副窗（只建一次，之后复用）。
func (a *App) buildPanels() {
	panelMu.Lock()
	defer panelMu.Unlock()
	if panelWins != nil {
		return
	}
	panelWins = map[string]*mygo.Window{}
	base := a.PageURL()
	for _, name := range []string{"eq", "lyric", "playlist"} {
		opts := mygo.WindowOptions{
			Title:        "千千静听",
			Width:        skinW,
			Height:       panelEqH,
			MinWidth:     skinW,
			MinHeight:    panelBarH,
			MaxWidth:     skinW,
			MaxHeight:    900,
			Frameless:    true,
			Transparent:  true,
			CornerRadius: 12,
			Hidden:       true,
			Page:         mygo.PageOptions{DevTools: mygo.DevToolsEnabled},
		}
		if base != "" {
			opts.URL = base + "?panel=" + name
		}
		w, err := newWinSafe(opts)
		if err != nil || w == nil {
			continue
		}
		w.Hide()
		// × 只收起窗口，不销毁，下次开皮肤界面直接复用。
		w.OnClose(func(e *mygo.CloseEvent) {
			e.PreventDefault()
			w.Hide()
		})
		panelWins[name] = w
	}
}

// panelLayout 把四个窗口竖着排：主窗在 a.win 的位置，三个副窗依次往下叠。
// 高度按工作区能放下的范围收敛，保证整列不会跑到屏幕外。
func (a *App) panelLayout() {
	panelMu.Lock()
	wins := panelWins
	panelMu.Unlock()
	if wins == nil || a.win == nil {
		return
	}
	mainX, mainY := a.win.Position()
	wa := mygo.Screen.PrimaryDisplay()
	workTop, workBottom := wa.WorkArea.Y, wa.WorkArea.Y+wa.WorkArea.Height
	if workTop == 0 && workBottom == 0 {
		workTop, workBottom = 0, 1080
	}
	x := mainX
	y := mainY
	if y+panelMainH > workBottom {
		y = workBottom - panelMainH
	}
	a.win.SetMinimumSize(skinW, panelMainH)
	a.win.SetSize(skinW, panelMainH)
	a.win.SetPosition(x, y)
	y += panelMainH + panelGap

	place := func(name string, h int) {
		if w, ok := wins[name]; ok {
			w.SetSize(skinW, h)
			w.SetPosition(x, y)
			y += h + panelGap
		}
	}
	place("eq", panelEqH)
	place("lyric", panelLyricH)
	plH := workBottom - y
	if plH < panelMinPl {
		plH = panelMinPl
	}
	if plH > panelMaxPl {
		plH = panelMaxPl
	}
	place("playlist", plH)
}

// showPanels 打开皮肤界面时调（主线程）。
func (a *App) showPanels() {
	a.buildPanels()
	a.panelLayout()
	panelPlaced = true
	panelMu.Lock()
	wins := panelWins
	panelMu.Unlock()
	for _, w := range wins {
		w.ShowInactive()
	}
}

// hidePanels 回桌面界面时把副窗收起来。
func (a *App) hidePanels() {
	panelPlaced = false
	panelMu.Lock()
	wins := panelWins
	panelMu.Unlock()
	for _, w := range wins {
		w.Hide()
	}
}

// panelByName 取副窗；name 为空时返回主窗。
func (a *App) panelByName(name string) *mygo.Window {
	if name == "" || name == "main" {
		return a.win
	}
	panelMu.Lock()
	defer panelMu.Unlock()
	if panelWins == nil {
		return nil
	}
	return panelWins[name]
}

// SyncPush 主窗把播放状态广播给三个副窗。
func (a *App) SyncPush(json string) {
	panelMu.Lock()
	wins := panelWins
	panelMu.Unlock()
	for _, w := range wins {
		p := w.Page()
		if p == nil {
			continue
		}
		go func(page *mygo.Page) {
			_, _ = page.Eval("window.__huluRecv && window.__huluRecv(" + quoteJS(json) + ")")
		}(p)
	}
}

// CmdSend 副窗把操作转给主窗（播放/切歌/改列表都归主窗执行）。
func (a *App) CmdSend(json string) {
	if a.win == nil {
		return
	}
	p := a.win.Page()
	if p == nil {
		return
	}
	go func(page *mygo.Page) {
		time.Sleep(time.Millisecond) // 让调用方那一帧先画完，命令再进页面
		_, _ = page.Eval("window.__huluCmd && window.__huluCmd(" + quoteJS(json) + ")")
	}(p)
}

// ShowPanel 主窗 PL/EQ/LRC 按钮把对应副窗重新显示出来。窗口早就建好，
// 只有第一次显示时才跟着主窗重新排一遍位置，之后保持用户自己拖过的地方。
func (a *App) ShowPanel(name string) {
	if name == "" || name == "main" {
		return
	}
	a.buildPanels()
	if !panelPlaced {
		a.panelLayout()
		panelPlaced = true
	}
	if w := a.panelByName(name); w != nil {
		w.ShowInactive()
	}
}

// HidePanel 副窗的 ×：把自己的窗口收起来。
func (a *App) HidePanel(name string) {
	if w := a.panelByName(name); w != nil && name != "main" && name != "" {
		w.Hide()
	}
}

// RollPanel 副窗的 □：往上卷成一条标题栏，再点回原高度。
func (a *App) RollPanel(name string, h float64) {
	w := a.panelByName(name)
	if w == nil || w == a.win {
		return
	}
	if h < panelBarH {
		h = panelBarH
	}
	if h > 900 {
		h = 900
	}
	w.SetSize(skinW, int(h))
}

// quoteJS 把字符串包成 JS 字面量（只用 strconv 的引号规则，避免注入）。
func quoteJS(s string) string {
	b := []byte{'"'}
	for _, r := range s {
		switch r {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			if r < 0x20 {
				continue
			}
			b = append(b, []byte(string(r))...)
		}
	}
	return string(append(b, '"'))
}
