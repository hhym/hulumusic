package qianqian

/* 电台录制。

   我们转出来的流本身就是 ADTS 帧，ADTS 是自带帧头的自同步格式，所以「录制」
   就是把这些帧不停 append 到一个 .aac 文件里，不需要额外封装、停止时也不用收尾。
   录完的文件可以直接拖进任何播放器（也能再喂回我们的播放器）。

   文件放数据目录下的「录音」文件夹，名字带台名和开始时间，方便回头找。 */

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	recMu      sync.Mutex
	recFile    *os.File
	recPath    string
	recStarted time.Time
	recBytes   int64
	recStation string
	recErr     string
)

// recSink 给 HLS 流转封装用的落盘入口；没在录的时候 recWrite 直接返回。
func recSink() func([]byte) { return func(p []byte) { recWrite(p) } }

func recWrite(p []byte) {
	recMu.Lock()
	defer recMu.Unlock()
	if recFile == nil {
		return
	}
	n, err := recFile.Write(p)
	recBytes += int64(n)
	if err != nil {
		recErr = err.Error()
		recFile.Close()
		recFile = nil
	}
}

// 文件名里不能出现的字符统一换掉，顺便把过长的台名截短。
func recSafeName(s string) string {
	s = strings.TrimSpace(s)
	repl := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	s = repl.Replace(s)
	s = strings.ReplaceAll(s, " ", "")
	if len([]rune(s)) > 40 {
		s = string([]rune(s)[:40])
	}
	if s == "" {
		s = "电台"
	}
	return s
}

func recInfoLocked() map[string]any {
	info := map[string]any{
		"recording": recFile != nil,
		"file":      recPath,
		"station":   recStation,
		"size":      recBytes,
	}
	if recFile != nil {
		info["seconds"] = int(time.Since(recStarted).Seconds())
	}
	if recErr != "" {
		info["error"] = recErr
	}
	return info
}

// StartRecording 开始录当前在播的电台。
func (a *App) StartRecording(name string) (map[string]any, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if recFile != nil {
		return recInfoLocked(), nil
	}
	dir := filepath.Join(dataDir(), "录音")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("建录音目录失败: %w", err)
	}
	path := filepath.Join(dir, fmt.Sprintf("%s-%s.aac", recSafeName(name), time.Now().Format("20060102-150405")))
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("建录音文件失败: %w", err)
	}
	// 先写个空的 ADTS 头也能让部分播放器认出格式，但没必要：ADTS 自同步，
	// 第一帧到了就自然成立。
	recFile = f
	recPath = path
	recStarted = time.Now()
	recBytes = 0
	recStation = name
	recErr = ""
	appLog("rec.log", "开始录制: "+path)
	return recInfoLocked(), nil
}

// StopRecording 停止录制并返回落盘信息（path 由前端拿去展示）。
func (a *App) StopRecording() (map[string]any, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if recFile != nil {
		recFile.Close()
		recFile = nil
		appLog("rec.log", fmt.Sprintf("停止录制: %s (%.1f MB)", recPath, float64(recBytes)/(1<<20)))
	}
	return recInfoLocked(), nil
}

// RecordingInfo 给前端轮询用：是否在录、录了多久、文件多大。
func (a *App) RecordingInfo() map[string]any {
	recMu.Lock()
	defer recMu.Unlock()
	return recInfoLocked()
}

// OpenRecordingDir 返回录音目录，前端可以拿来提示路径。
func (a *App) RecordingDir() string {
	return filepath.Join(dataDir(), "录音")
}
