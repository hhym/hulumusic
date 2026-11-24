package qianqian

import (
	"encoding/binary"
	"runtime"
	"testing"
)

// 内置的 ffmpeg 必须是一份 Windows x64 的 PE 可执行文件，
// 否则打包时 embed 错了文件、或者文件被截断都不会有人发现。
func TestEmbeddedFFmpegIsWindowsPE(t *testing.T) {
	if len(ffmpegWin64) < 1<<20 {
		t.Fatalf("内置 ffmpeg 只有 %d 字节，像是被截断了", len(ffmpegWin64))
	}
	if string(ffmpegWin64[:2]) != "MZ" {
		t.Fatalf("内置 ffmpeg 不是 PE 文件（开头是 %q）", ffmpegWin64[:2])
	}
	pe := int(binary.LittleEndian.Uint32(ffmpegWin64[0x3c:]))
	if pe <= 0 || pe+6 > len(ffmpegWin64) {
		t.Fatalf("PE 头偏移不合理：%d", pe)
	}
	if sig := string(ffmpegWin64[pe : pe+4]); sig != "PE\x00\x00" {
		t.Fatalf("PE 签名不对：%q", sig)
	}
	machine := binary.LittleEndian.Uint16(ffmpegWin64[pe+4:])
	if machine != 0x8664 {
		t.Fatalf("内置 ffmpeg 不是 x64（machine=0x%x）", machine)
	}
}

// 非 Windows 上不该解压出任何东西（内置的是 windows 版），
// 但也不能报错——插件在 mac/linux 上仍然走系统 ffmpeg。
func TestEnsureBuiltinFFmpegOtherOS(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows 上应该真的解压一份出来，这里不碰磁盘")
	}
	if p := ensureBuiltinFFmpeg(); p != "" {
		t.Fatalf("非 windows 不该返回内置路径，拿到 %q", p)
	}
}

func TestResolveFFmpegPrefersExisting(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("这条只在有 /usr/bin/ffmpeg 的开发机上跑")
	}
	p, ok := resolveFFmpeg("ffmpeg")
	if !ok || p == "" {
		t.Skip("本机没有 ffmpeg，跳过")
	}
	if p == "ffmpeg" {
		t.Fatalf("应解析成绝对路径，实际还是 %q", p)
	}
	if _, ok := resolveFFmpeg("definitely-not-a-binary-xyz"); ok {
		t.Fatalf("不存在的程序不该被当成可用")
	}
}
