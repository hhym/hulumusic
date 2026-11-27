package qianqian

import (
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "embed"
)

/* 应用图标切换（设置页「图标」那一行用）。
   两套 ico 都编进 exe，运行时解压到 <dataDir>/icons/，再用 Win32 的
   WM_SETICON 换掉窗口图标（标题栏 + 任务栏一起变）。
   exe 文件本身的图标仍是编译时那个，运行中改不了。 */

//go:embed assets/icon-neon.ico
var iconNeon []byte

//go:embed assets/icon-sunset.ico
var iconSunset []byte

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

// SetAppIcon 切换窗口图标：classic（恢复 exe 自带）/ neon（霓虹）/ sunset（暖橙）。
// 顺手把选择写回 settings.json（端口每次启动都会变，前端 localStorage 靠不住）。
// 返回实际用的 ico 路径，classic 或失败时为空。
func (a *App) SetAppIcon(name string) (string, string) {
	if name == "" {
		name = "classic"
	}
	var p string
	switch name {
	case "classic":
		// 恢复 exe 自带图标
	case "neon":
		p = writeIconFile("icon-neon.ico", iconNeon)
	case "sunset":
		p = writeIconFile("icon-sunset.ico", iconSunset)
	default:
		return "", "未知图标：" + name
	}
	if name != "classic" && p == "" {
		return "", "图标解压失败"
	}
	a.mu.Lock()
	s := a.loadSettings()
	s.Icon = name
	_ = a.saveSettings(s)
	a.mu.Unlock()
	applyWindowIcon(p)
	return p, ""
}

// applySavedIcon 启动时按 settings.json 里的选择恢复窗口图标。
// 窗口句柄通常比 startup 晚几百毫秒才出现，所以轮询十来秒。
func (a *App) applySavedIcon() {
	name := a.loadSettings().Icon
	if name != "neon" && name != "sunset" {
		return
	}
	go func() {
		var p string
		if name == "neon" {
			p = writeIconFile("icon-neon.ico", iconNeon)
		} else {
			p = writeIconFile("icon-sunset.ico", iconSunset)
		}
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
