package qianqian

import (
	"os"
	"path/filepath"
	"testing"
)

// 同一个 id 既留着早前装失败的空目录、又有后来装好的 <id>.js 时，
// 类型必须按「装的是单文件」来判，不然会被当成 MyGo 执行，报相对路径 import 错。
func TestPluginKindPrefersSingleFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HULU_DATA_DIR", dir)
	app := &App{}

	// 1) 单文件插件
	if _, err := app.installPluginJS("GD音乐台.js", []byte("module.exports = {platform: 'GD音乐台'}")); err != nil {
		t.Fatal(err)
	}
	if k, _ := app.PluginKind("GD音乐台"); k != "musicfree" {
		t.Fatalf("单文件插件应判为 musicfree，得到 %q", k)
	}
	if p, ok := pluginEntryFile("GD音乐台"); !ok || filepath.Base(p) != "GD音乐台.js" {
		t.Fatalf("入口文件应指向 GD音乐台.js，得到 %q ok=%v", p, ok)
	}

	// 2) 制造老数据冲突：同名目录 + plugin.json
	legacy := pluginDir("GD音乐台")
	os.MkdirAll(legacy, 0o755)
	os.WriteFile(filepath.Join(legacy, "plugin.json"), []byte(`{"id":"GD音乐台","name":"GD","main":"index.js"}`), 0o644)
	os.WriteFile(filepath.Join(legacy, "index.js"), []byte("import axios from 'axios'"), 0o644)

	// 记录还在，仍是 musicfree
	if k, _ := app.PluginKind("GD音乐台"); k != "musicfree" {
		t.Fatalf("有记录时应保持 musicfree，得到 %q", k)
	}

	// 3) 去掉记录（模拟升级前的老数据），扫描应自愈成 musicfree 且列表只出一份
	os.Remove(pluginKindsPath())
	list := app.scanPlugins()
	cnt := 0
	for _, p := range list {
		if p.ID == "GD音乐台" {
			cnt++
			if p.Kind != "musicfree" {
				t.Fatalf("老数据冲突时应自愈成 musicfree，得到 %q", p.Kind)
			}
			if p.File != "GD音乐台.js" {
				t.Fatalf("应报单文件入口，得到 %q", p.File)
			}
		}
	}
	if cnt != 1 {
		t.Fatalf("同 id 冲突只应出一条，实际 %d 条", cnt)
	}
	if k, _ := app.PluginKind("GD音乐台"); k != "musicfree" {
		t.Fatalf("扫描后应补上记录，得到 %q", k)
	}

	// 4) 再装同名目录型插件：类型翻成 mygo，单文件被清掉
	src := t.TempDir()
	os.WriteFile(filepath.Join(src, "plugin.json"), []byte(`{"id":"GD音乐台","name":"GD","main":"index.js"}`), 0o644)
	os.WriteFile(filepath.Join(src, "index.js"), []byte("export async function search() { return [] }"), 0o644)
	if _, err := app.installPluginDir(src); err != nil {
		t.Fatal(err)
	}
	if k, _ := app.PluginKind("GD音乐台"); k != "mygo" {
		t.Fatalf("装目录型后应为 mygo，得到 %q", k)
	}
	if _, err := os.Stat(filepath.Join(pluginsDir(), "GD音乐台.js")); !os.IsNotExist(err) {
		t.Fatalf("同名单文件应被清掉")
	}
}
