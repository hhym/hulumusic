// 千千静听 · 独立版入口。
//
// 这里不再有 mygo-music：没有它的原生窗口、原生菜单、原生插件页和音乐库。
// 整个程序只有两样东西 —— mygo 这个窗口/WebView 框架，和 qianqian 这个自包含的
// 皮肤播放器后端（起本地 http、喂 page.html、装插件、扫本地音乐）。
//
// 构建：
//
//	go build -ldflags "-H windowsgui" -o hulu-music.exe .
package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/egoist/mygo"

	"hulu-music/qianqian"
)

// dataDirPath 和 qianqian 里的 dataDir() 保持一致：独立版用自己的文件夹。
func dataDirPath() string {
	if dir := os.Getenv("HULU_DATA_DIR"); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	dir := filepath.Join(home, ".hulu-music")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// bootLog 写一行启动日志：双击 exe 没有控制台，出问题只能靠这个文件。
func bootLog(format string, args ...any) {
	f, err := os.OpenFile(filepath.Join(dataDirPath(), "qqjt-boot.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// migrateOldData 首次启动时把加装版（~/.hulu-music-desktop）里的插件和设置
// 抄一份过来：加装版原目录不动，两边从此各管各的。已经有数据就跳过。
func migrateOldData() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	old := filepath.Join(home, ".hulu-music-desktop")
	dst := dataDirPath()
	if old == dst {
		return
	}
	if _, err := os.Stat(old); err != nil {
		return
	}
	if _, err := os.Stat(filepath.Join(dst, "settings.json")); err == nil {
		return
	}
	if _, err := os.Stat(filepath.Join(dst, "plugins.json")); err == nil {
		return
	}
	items := []string{"plugins", "plugin-data", "plugins.json", "plugin-settings.json", "settings.json", "library.json"}
	for _, it := range items {
		copyTree(filepath.Join(old, it), filepath.Join(dst, it))
	}
	bootLog("已从旧目录迁移插件与设置：%s → %s", old, dst)
}

// copyTree 递归复制；目标已存在的文件一律跳过，不覆盖用户数据。
func copyTree(src, dst string) {
	fi, err := os.Stat(src)
	if err != nil {
		return
	}
	if fi.IsDir() {
		_ = os.MkdirAll(dst, 0o755)
		entries, err := os.ReadDir(src)
		if err != nil {
			return
		}
		for _, e := range entries {
			copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name()))
		}
		return
	}
	if _, err := os.Stat(dst); err == nil {
		return
	}
	in, err := os.Open(src)
	if err != nil {
		return
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return
	}
	defer out.Close()
	_, _ = io.Copy(out, in)
}

// safeNewWindow 包一层 recover：mygo 在 WebView2 初始化失败时直接
// panic("mygo: cannot create window: ...")，windowsgui 构建没有控制台，
// 进程就这么静默退掉了，用户看到的就是"双击没反应"。这里兜住、写日志、弹框。
func safeNewWindow(opts mygo.WindowOptions) (win *mygo.Window, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return mygo.NewWindow(opts), nil
}

// main 包一层 recover：GUI 构建没有控制台，main 里任何 panic 都会让进程静默消失，
// 用户看到的就是"双击没反应"。这里兜住并写日志 + 弹框，至少能查到死在哪一步。
func main() {
	defer func() {
		if r := recover(); r != nil {
			bootLog("!!! main panic: %v\n%s", r, debug.Stack())
			showMessage("千千静听 · 启动异常", fmt.Sprint(r), true)
		}
	}()
	runApp()
}

func runApp() {
	dir := dataDirPath()
	bootLog("=== 启动，数据目录 %s", dir)
	if !mygo.App.RequestSingleInstanceLock() {
		bootLog("已有实例在运行，本次退出")
		showMessage("千千静听", "程序已经在运行了，请先在任务栏/托盘里找到已打开的窗口。\n如果找不到，请在任务管理器里结束「千千静听.exe」后重试。", false)
		os.Exit(0)
	}
	bootLog("单实例锁已拿到")

	migrateOldData()
	bootLog("旧数据迁移检查完成")

	a := qianqian.NewApp()
	bootLog("后端 App 已创建")
	mygo.BindAs("App", qianqian.NewAPI(a))
	bootLog("后端方法已绑定")
	mygo.App.WhenReady(func() {
		// 先把本地服务起起来，拿到真实 http origin，再把地址交给窗口创建。
		// 早先的做法是先建空窗口、1.2 秒后再 LoadURL，Windows 上会多出一个
		// 空白的第二个窗口（WebView2 没挂到我们建的窗口上），桌面上看到就是
		// 一块黑。窗口创建时直接给 URL 走 mygo 的标准路径，只有一个窗口。
		bootLog("WhenReady 回调触发")
		a.Start()
		url := a.PageURL()
		a.SetPageURL(url)
		bootLog("本地页面服务已启动，url=%q", url)

		// WebView2 缺失时 NewWindow 会直接 panic，先探一下，给一句人话。
		if !mygo.WebViewAvailable() {
			bootLog("WebView2 运行时不可用")
			showMessage("千千静听 · 缺少 WebView2 运行时",
				"这台电脑上找不到 Microsoft Edge WebView2 运行时，界面无法创建。\n\n"+
					"请安装「Microsoft Edge WebView2 Runtime」（Evergreen 版）后重新打开程序：\n"+
					"https://developer.microsoft.com/microsoft-edge/webview2/\n\n"+
					"详细日志：%USERPROFILE%\\.hulu-music\\qqjt-boot.log", true)
			return
		}
		opts := mygo.WindowOptions{
			Title:     "千千静听",
			Width:     1190,
			Height:    780,
			MinWidth:  460,
			MinHeight: 560,
			// 无边框 + 透明：系统标题栏不要了，改由页面顶部的拖动条拖动、
			// 自绘最小化/关闭。透明是为了迷你模式——窗口缩到 348×124 时页面
			// 背景变透明，只剩那张带圆角的迷你卡露在外面，像贴在桌面上的浮卡。
			Frameless:    true,
			Transparent:  true,
			CornerRadius: 12,
			Page:         mygo.PageOptions{DevTools: mygo.DevToolsEnabled},
		}
		if url != "" {
			opts.URL = url
		}
		bootLog("开始建窗 %dx%d（最小 %dx%d）", opts.Width, opts.Height, opts.MinWidth, opts.MinHeight)
		win, err := safeNewWindow(opts)
		if err != nil {
			bootLog("建窗失败: %v", err)
			showMessage("千千静听 · 窗口创建失败",
				"创建窗口时出错了：\n\n"+err.Error()+"\n\n"+
					"常见原因是 WebView2 运行时缺失或损坏，装一个 Evergreen 版 WebView2 再试。\n"+
					"日志：%USERPROFILE%\\.hulu-music\\qqjt-boot.log", true)
			return
		}
		a.AttachWindow(win)
		// 右键菜单换成中文：WebView2 自带的是英文（Back/Refresh/Save as…）。
		installChineseContextMenu(win)
		// 窗口/任务栏图标：千千静听橙圈图标，透明圆边。
		if err := win.SetIcon(qianqian.IconPNG()); err != nil {
			bootLog("设置图标失败: %v", err)
		}
		bootLog("窗口已建，page url: %q", url)

		// 云听目录预热：电台页第一次打开要有央广台，别让它等接口
		go qianqian.WarmCloudCatalog()

		win.OnClose(func(e *mygo.CloseEvent) { bootLog("窗口收到关闭请求") })
		win.OnClosed(func() { bootLog("窗口已关闭") })

		// 拖放装插件：把 .zip（或插件文件夹）直接拖进窗口就装好，不经过系统
		// 文件对话框 —— 拖放拿的是真实路径，最省事。
		win.OnFileDrop(func(e *mygo.FileDropEvent) {
			for _, p := range e.Paths {
				low := strings.ToLower(p)
				if !strings.HasSuffix(low, ".zip") {
					if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
						continue
					}
				}
				prev, _ := a.Plugins()
				before := len(prev)
				r := a.InstallPluginFile(p)
				bootLog("拖放安装 %s → installedId=%q err=%q（装前 %d 个，装后 %d 个）",
					p, r.InstalledID, r.Err, before, len(r.Plugins))
				if page := win.Page(); page != nil {
					_, _ = page.Eval(`window.dispatchEvent(new CustomEvent('hulu-plugin-installed'))`)
				}
			}
		})

		// 页面 <title> 是「千千静听 · Wails 桌面版」，会盖掉窗口标题，拦下来。
		if p := win.Page(); p != nil {
			p.OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
		}

		// 回读一次真实状态，方便从日志判断到底加载到了什么。
		go func() {
			time.Sleep(2500 * time.Millisecond)
			page := win.Page()
			if page == nil {
				bootLog("page handle 是 nil，无法回读")
				return
			}
			v, err := page.Eval("document.location.href + '|' + document.body.innerHTML.length")
			bootLog("加载后状态: %v err=%v", v, err)
			bad := err != nil
			if s, ok := v.(string); ok {
				if strings.Contains(s, "about:blank") || strings.HasSuffix(s, "|0") {
					bad = true
				}
			}
			if bad {
				bootLog("本地服务页面没起来，回退内联页面")
				page.LoadHTML(qianqian.Page(), "")
				time.Sleep(1500 * time.Millisecond)
				v2, _ := page.Eval("document.location.href + '|' + document.body.innerHTML.length + '|' + (typeof window.go)")
				bootLog("回退后状态: %v", v2)
			}
		}()
	})
	bootLog("进入 App.Run()")
	if err := mygo.App.Run(); err != nil {
		bootLog("Run 退出: %v", err)
		showMessage("千千静听 · 事件循环启动失败", fmt.Sprint(err), true)
		log.Fatal(err)
	}
	bootLog("Run 正常返回（事件循环结束）")
}
