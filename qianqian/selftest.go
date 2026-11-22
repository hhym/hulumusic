package qianqian

// 自检：只在设置了环境变量 HULU_SELFTEST=1 时运行，正常启动完全不碰它。
// 目的：在没法点鼠标的环境（远程/自动化）里，把「四窗有没有建出来、位置对不对、
// 主窗推给副窗的状态有没有真的送到页面、窗口能不能被程序搬动」逐条写进启动日志。
// 真机验收时先看清这几条，再谈手感。

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

func SelfTestEnabled() bool { return os.Getenv("HULU_SELFTEST") == "1" }

// selfTestEnabled 保留内部小写别名，供同包其它文件使用。
func selfTestEnabled() bool { return SelfTestEnabled() }

// RunSelfTest 由 main 在窗口就绪后按需调用，全程在后台跑，不阻塞界面。
func RunSelfTest(a *App, win *mygo.Window) {
	go func() {
		st := func(format string, args ...any) {
			appLog("qqjt-boot.log", "[selftest] "+fmt.Sprintf(format, args...))
		}
		time.Sleep(3 * time.Second)
		st("开始：主窗 %s", winRectText(win))

		// 1) 进皮肤模式，看四个窗口有没有都建出来、是不是竖排。
		mygo.RunOnMain(func() { a.skinOn() })
		time.Sleep(2 * time.Second)
		st("皮肤模式后：%s", allRectsText(a, win))

		// 2) 主窗往副窗推一条状态（配色换成烧歌橙），再回读副窗页面的 data-skin。
		payload := `{"cur":null,"playing":false,"busy":false,"pos":0,"dur":0,"lyric":[],` +
			`"curIndex":-1,"queue":{"list":[],"idx":0},"volume":1,"eqGains":[],"eqOn":false,` +
			`"eqPreset":0,"eqPresets":[],"shuffle":false,"inLib":false,"skin":"orange"}`
		a.SyncPush(payload)
		time.Sleep(1500 * time.Millisecond)
		for _, name := range []string{"eq", "lyric", "playlist"} {
			w := a.panelByName(name)
			if w == nil || w.Page() == nil {
				st("%s: 拿不到页面", name)
				continue
			}
			v, err := w.Page().Eval(`(()=>{const el=document.querySelector('.skin-view');` +
				`return JSON.stringify({skin: el?el.getAttribute('data-skin'):'no-view',` +
				`recv: typeof window.__huluRecv, cmd: typeof window.__huluCmd})})()`)
			st("%s 回读: %v err=%v", name, v, err)
		}

		// 3) 程序直接搬一个副窗：验证 SetWindowPos 这条路本身是通的。
		ly := a.panelByName("lyric")
		if ly != nil {
			x, y := ly.Position()
			ly.SetPosition(x+80, y+40)
			time.Sleep(500 * time.Millisecond)
			nx, ny := ly.Position()
			st("搬歌词窗 (%d,%d) → (%d,%d)", x, y, nx, ny)
		}

		// 4) 点一下副窗上的「+」按钮这种交互没法自动化，只能靠真手；这里只报告结论。
		st("完成：请对着日志核对 1) 四窗 2) 配色 3) 窗口位置")
	}()
}

func winRectText(w *mygo.Window) string {
	if w == nil {
		return "nil"
	}
	x, y := w.Position()
	return fmt.Sprintf("(%d,%d)", x, y)
}

func allRectsText(a *App, main *mygo.Window) string {
	var b strings.Builder
	if main != nil {
		x, y := main.Position()
		fmt.Fprintf(&b, "main(%d,%d)", x, y)
	}
	panelMu.Lock()
	for _, n := range []string{"eq", "lyric", "playlist"} {
		if w := panelWins[n]; w != nil {
			x, y := w.Position()
			fmt.Fprintf(&b, " %s(%d,%d)", n, x, y)
		} else {
			fmt.Fprintf(&b, " %s(未建)", n)
		}
	}
	panelMu.Unlock()
	return b.String()
}
