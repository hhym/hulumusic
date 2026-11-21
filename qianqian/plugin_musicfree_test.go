package qianqian

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// MusicFree 单文件插件：装 .js → 列表里出现 kind=musicfree → 能删掉。
func TestMusicFreeSingleFileLifecycle(t *testing.T) {
	dir := t.TempDir()
	os.Setenv("HULU_DATA_DIR", dir)
	defer os.Unsetenv("HULU_DATA_DIR")

	a := &App{}
	code := []byte("const axios = require('axios')\nmodule.exports = { platform: 'test', search: async () => ({ data: [] }) }\n")

	for _, name := range []string{"QQ_猫.js", "QQ音乐 （非VIP）.js", "GD音乐台.js"} {
		id, err := a.installPluginJS(name, code)
		if err != nil {
			t.Fatalf("装 %s 失败：%v", name, err)
		}
		if id == "" {
			t.Fatalf("%s 没拿到 id", name)
		}
		if _, err := os.Stat(filepath.Join(pluginsDir(), id+".js")); err != nil {
			t.Fatalf("%s 没落到磁盘：%v", name, err)
		}
	}

	list := a.scanPlugins()
	var mf []Plugin
	for _, p := range list {
		if p.Kind == "musicfree" {
			mf = append(mf, p)
		}
	}
	if len(mf) != 3 {
		t.Fatalf("期望 3 个 musicfree 插件，实际 %d（%+v）", len(mf), list)
	}
	for _, p := range mf {
		if !p.Enabled || !p.Compatible || p.File == "" {
			t.Fatalf("插件条目不完整：%+v", p)
		}
		if strings.Contains(p.ID, " ") || strings.Contains(p.ID, "（") {
			t.Fatalf("id 没消毒干净：%v", p.ID)
		}
	}

	// 源码能被读回（前端 runtime 靠这个执行）
	src, e := a.PluginSource(mf[0].ID)
	if e != "" || !strings.Contains(src, "module.exports") {
		t.Fatalf("读源码失败：%q", e)
	}

	if _, e := a.RemovePlugin(mf[0].ID); e != "" {
		t.Fatalf("删除失败：%s", e)
	}
	if _, err := os.Stat(filepath.Join(pluginsDir(), mf[0].ID+".js")); err == nil {
		t.Fatalf("删除后文件还在")
	}
	after := a.scanPlugins()
	cnt := 0
	for _, p := range after {
		if p.Kind == "musicfree" {
			cnt++
		}
	}
	if cnt != 2 {
		t.Fatalf("删除后期望剩 2 个，实际 %d", cnt)
	}
}

// 粘贴源码（无文件名）也要能装：id 用时间戳兜底。
func TestMusicFreeInstallFromText(t *testing.T) {
	dir := t.TempDir()
	os.Setenv("HULU_DATA_DIR", dir)
	defer os.Unsetenv("HULU_DATA_DIR")

	a := &App{}
	r := a.InstallPluginText("module.exports = { platform: 'pasted' }")
	if r.Err != "" || r.InstalledID == "" {
		t.Fatalf("粘贴安装失败：%v / %v", r.Err, r.InstalledID)
	}
	found := false
	for _, p := range r.Plugins {
		if p.ID == r.InstalledID && p.Kind == "musicfree" {
			found = true
		}
	}
	if !found {
		t.Fatalf("粘贴安装后列表里没有：%+v", r.Plugins)
	}
}
