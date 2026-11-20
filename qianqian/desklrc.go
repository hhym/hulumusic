package qianqian

import (
	"encoding/json"
	"fmt"

	"github.com/egoist/mygo"
)

/* 桌面歌词：一个独立的小窗口，无边框、透明、置顶、不在任务栏里。

   主窗口更新歌词时把整行文字推过来（DeskLrcText），这里只是 Eval 一句
   window.__dl(line, title)，不重复实现歌词解析——解析留在前端，一份逻辑。

   注意：两个 WebView 是两个页面，localStorage / 音频都不共享，所以这扇窗
   只做显示：拖它用 CSS --app-region: drag，双击/右键由页面自己处理。 */

// newWindowSafe 兜住 mygo.NewWindow 的 panic（WebView2 缺失时会 panic）。
func newWindowSafe(opts mygo.WindowOptions) (w *mygo.Window, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return mygo.NewWindow(opts), nil
}

// SetPageURL 记下界面地址，桌面歌词窗口要用同一个 origin 才能读到同一份资源。
func (a *App) SetPageURL(u string) {
	a.mu.Lock()
	a.pageURL = u
	a.mu.Unlock()
}

// DeskLrc 开关桌面歌词窗口，返回开关后的状态。
func (a *App) DeskLrc(on bool) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if !on {
		if a.desk != nil {
			w := a.desk
			a.desk = nil
			w.Close()
		}
		return false, nil
	}
	if a.desk != nil {
		a.desk.Focus()
		return true, nil
	}
	if a.pageURL == "" {
		return false, fmt.Errorf("界面地址还没准备好，稍后再试")
	}
	opts := mygo.WindowOptions{
		Title:           "桌面歌词",
		Width:           620,
		Height:          110,
		Frameless:       true,
		Transparent:     true,
		AlwaysOnTop:     true,
		SkipTaskbar:     true,
		DisableResize:   true,
		DisableMaximize: true,
		DisableMinimize: true,
		DisableShadow:   true,
		CornerRadius:    0,
		URL:             a.pageURL + "?desklrc=1",
	}
	w, err := newWindowSafe(opts)
	if err != nil {
		appLog("desklrc.log", "桌面歌词建窗失败: "+err.Error())
		return false, fmt.Errorf("桌面歌词窗口创建失败：%v", err)
	}
	a.desk = w
	w.Center()
	w.OnClosed(func() {
		a.mu.Lock()
		a.desk = nil
		a.mu.Unlock()
		appLog("desklrc.log", "桌面歌词窗口已关闭")
	})
	appLog("desklrc.log", "桌面歌词窗口已创建")
	return true, nil
}

// DeskLrcState 给页面回读用：刷新后按钮状态要对得上。
func (a *App) DeskLrcState() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.desk != nil
}

// DeskLrcText 把当前歌词行推给桌面歌词窗口。窗口没开就静默返回。
func (a *App) DeskLrcText(line string, title string) error {
	a.mu.Lock()
	w := a.desk
	a.mu.Unlock()
	if w == nil {
		return nil
	}
	p := w.Page()
	if p == nil {
		return nil
	}
	bLine, _ := json.Marshal(line)
	bTitle, _ := json.Marshal(title)
	_, err := p.Eval(fmt.Sprintf("window.__dl && window.__dl(%s, %s)", bLine, bTitle))
	return err
}

// ── 绑定层 ──────────────────────────────────────────────────────────────

// DeskLrc 给前端：DeskLrc(true/false) → (是否打开, 错误)。
func (x API) DeskLrc(on any) (bool, error) {
	v, err := x.App.DeskLrc(as[bool](on))
	if err != nil {
		return false, err
	}
	return v, nil
}

// DeskLrcState 回读开关状态。
func (x API) DeskLrcState() bool { return x.App.DeskLrcState() }

// SetAlwaysOnTop 给前端用：主窗口置顶开关。
func (x API) SetAlwaysOnTop(on any) bool { return x.App.SetAlwaysOnTop(as[bool](on)) }

// DeskLrcText 推送一行歌词（仅在窗口开着时有效）。
func (x API) DeskLrcText(line any, title any) (bool, error) {
	if err := x.App.DeskLrcText(as[string](line), as[string](title)); err != nil {
		return false, err
	}
	return true, nil
}

// SetAlwaysOnTop 给 TT 模式歌词窗的「置顶」键用：把主窗口钉在最前面。
func (a *App) SetAlwaysOnTop(on bool) bool {
	a.mu.Lock()
	w := a.win
	a.mu.Unlock()
	if w == nil {
		return false
	}
	w.SetAlwaysOnTop(on)
	return w.IsAlwaysOnTop()
}
