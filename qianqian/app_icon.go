package qianqian

import (
	"embed"
	"os"
	"path/filepath"
	"sync"
	"time"
)

/* 应用图标切换（设置页「图标」那一行用）。
   两套 ico 都编进 exe，运行时解压到 <dataDir>/icons/，再用 Win32 的
   WM_SETICON 换掉窗口图标（标题栏 + 任务栏一起变）。
   exe 文件本身的图标仍是编译时那个，运行中改不了。 */

// 全部图标一套打进 exe：icon-neon / icon-sunset + 11 套配色图标。
//go:embed assets/*.ico
var iconFS embed.FS

// IconIDs 可选的图标：classic 是 exe 自带（千千静听新图标），其余都是 assets 里的 .ico
var IconIDs = []string{
	"classic", "neon", "sunset",
	"retro-brown", "retro-brass", "retro-wine",
	"cyber-violet", "cyber-dusk", "cyber-rose",
	"mist-blue", "sage-green", "oat-beige",
	"klein-blue", "tomato-indigo",
}

func iconBytes(name string) []byte {
	b, err := iconFS.ReadFile("assets/icon-" + name + ".ico")
	if err != nil {
		return nil
	}
	return b
}

// iconFile 把某套图标解压到磁盘并返回路径，未知 / 失败返回空串。
func iconFile(name string) string {
	b := iconBytes(name)
	if b == nil {
		return ""
	}
	return writeIconFile("icon-"+name+".ico", b)
}

var (
	iconOnce sync.Once
	iconDir  string
)

func ensureIconDir() string {
	iconOnce.Do(func() {
		d := filepath.Join(dataDir(), "icons")
		if err := os.MkdirAll(d, 0o755); err != nil {
			return
		}
		iconDir = d
	})
	return iconDir
}

func writeIconFile(name string, data []byte) string {
	d := ensureIconDir()
	if d == "" {
		return ""
	}
	dst := filepath.Join(d, name)
	if st, err := os.Stat(dst); err == nil && st.Size() == int64(len(data)) {
		return dst
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		os.Remove(tmp)
		return ""
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return ""
	}
	return dst
}

// SetAppIcon 切换窗口图标：classic（恢复 exe 自带）或任一套配色图标。
// 顺手把选择写回 settings.json（端口每次启动都会变，前端 localStorage 靠不住）。
// 返回实际用的 ico 路径，classic 或失败时为空。
func (a *App) SetAppIcon(name string) (string, string) {
	if name == "" {
		name = "classic"
	}
	var p string
	if name != "classic" {
		p = iconFile(name)
		if p == "" {
			return "", "未知图标：" + name
		}
	}
	a.mu.Lock()
	sv := a.loadSettings()
	sv.Icon = name
	_ = a.saveSettings(sv)
	a.mu.Unlock()
	applyWindowIcon(p)
	return p, ""
}

// applySavedIcon 启动时按 settings.json 里的选择恢复窗口图标。
// 窗口句柄通常比 startup 晚几百毫秒才出现，所以轮询十来秒。
func (a *App) applySavedIcon() {
	name := a.loadSettings().Icon
	if name == "" || name == "classic" {
		return
	}
	go func() {
		p := iconFile(name)
		if p == "" {
			return
		}
		for i := 0; i < 40; i++ {
			if applyWindowIcon(p) {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
	}()
}
