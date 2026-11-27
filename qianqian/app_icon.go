package qianqian

import (
	"os"
	"path/filepath"
	"sync"

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
// 返回实际用的 ico 路径，classic 或失败时为空。
func (a *App) SetAppIcon(name string) (string, string) {
	switch name {
	case "", "classic":
		applyWindowIcon("")
		return "", ""
	case "neon":
		p := writeIconFile("icon-neon.ico", iconNeon)
		if p == "" {
			return "", "图标解压失败"
		}
		applyWindowIcon(p)
		return p, ""
	case "sunset":
		p := writeIconFile("icon-sunset.ico", iconSunset)
		if p == "" {
			return "", "图标解压失败"
		}
		applyWindowIcon(p)
		return p, ""
	default:
		return "", "未知图标：" + name
	}
}
