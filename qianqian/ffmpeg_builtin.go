package qianqian

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

	_ "embed"
)

/* 播放器自带的 Windows 版 ffmpeg（极简构建：只留 aac/mp3 解码、aac 编码、
   mp4/adts 封装、http/https(file/tcp) 协议 + Windows 自带 TLS，2.6 MB）。
   主要给「85听书」「蜻蜓」这类音频是 HE-AAC、需要转码才能放的插件用。
   首次调用时解压到 <dataDir>/ffmpeg/ffmpeg.exe，之后直接复用。 */

//go:embed assets/ffmpeg-win64.exe
var ffmpegWin64 []byte

var (
	ffmpegOnce sync.Once
	ffmpegPath string
)

// ensureBuiltinFFmpeg 返回内置 ffmpeg 的落盘路径（失败返回空字符串）
func ensureBuiltinFFmpeg() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	ffmpegOnce.Do(func() {
		dst := filepath.Join(dataDir(), "ffmpeg", "ffmpeg.exe")
		if st, err := os.Stat(dst); err == nil && st.Size() == int64(len(ffmpegWin64)) {
			ffmpegPath = dst
			return
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return
		}
		// 先写临时文件再改名，避免上次解压中断留下半个 exe
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, ffmpegWin64, 0o755); err != nil {
			os.Remove(tmp)
			return
		}
		if err := os.Rename(tmp, dst); err != nil {
			os.Remove(tmp)
			return
		}
		ffmpegPath = dst
	})
	return ffmpegPath
}

// resolveFFmpeg：能直接跑就用插件/用户给的那个，跑不起来才回退内置。
func resolveFFmpeg(bin string) (string, bool) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, true
	}
	if bin != "" && (filepath.IsAbs(bin) || filepath.VolumeName(bin) != "") {
		if st, err := os.Stat(bin); err == nil && !st.IsDir() {
			return bin, true
		}
	}
	if p := ensureBuiltinFFmpeg(); p != "" {
		return p, true
	}
	return bin, false
}
