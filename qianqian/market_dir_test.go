package qianqian

import (
	"os"
	"path/filepath"
	"testing"
)

// 市场目录里的插件要能被列出来并装上：子文件夹按 MyGo、.js 按 MusicFree。
func TestMarketDirScanAndInstall(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HULU_DATA_DIR", dir)
	app := &App{}

	// 默认市场目录里放一个 MusicFree 插件 + 一个 MyGo 插件文件夹 + 一个无关文件
	md := defaultMarketDir()
	mfCode := "module.exports = { platform: '街角电台', version: '1.2.0', search: async () => [] }"
	if err := os.WriteFile(filepath.Join(md, "街角电台.js"), []byte(mfCode), 0o644); err != nil {
		t.Fatal(err)
	}
	mg := filepath.Join(md, "我的源")
	os.MkdirAll(mg, 0o755)
	os.WriteFile(filepath.Join(mg, "plugin.json"), []byte(`{"id":"我的源","name":"我的源","version":"0.9.0","description":"测试目录插件","main":"index.js"}`), 0o644)
	os.WriteFile(filepath.Join(mg, "index.js"), []byte("export async function search() { return [] }"), 0o644)
	os.WriteFile(filepath.Join(md, "readme.txt"), []byte("不是插件"), 0o644)

	items, msg := app.PluginMarket()
	if msg != "" {
		t.Fatalf("清单应该能读，报错：%s", msg)
	}
	got := map[string]MarketItem{}
	for _, it := range items {
		got[it.ID] = it
	}
	if it, ok := got["街角电台"]; !ok || it.Kind != "musicfree" || it.Source != "local" {
		t.Fatalf("市场目录里的 .js 应列成 musicfree 本地条目，得到 %+v", it)
	}
	if it, ok := got["我的源"]; !ok || it.Kind != "mygo" || it.Path == "" {
		t.Fatalf("市场目录里的插件文件夹应列成 mygo 条目，得到 %+v", it)
	}
	if _, ok := got["readme"]; ok {
		t.Fatalf("非插件文件不该出现在市场里")
	}

	// 点安装：本地条目走 installPluginJS / installPluginDir
	r := app.InstallMarketPlugin("街角电台")
	if r.Err != "" || r.InstalledID == "" {
		t.Fatalf("装本地 .js 失败：%+v", r)
	}
	if k, _ := app.PluginKind("街角电台"); k != "musicfree" {
		t.Fatalf("装好后应记成 musicfree，得到 %q", k)
	}
	b, err := os.ReadFile(filepath.Join(pluginsDir(), "街角电台.js"))
	if err != nil || string(b) != mfCode {
		t.Fatalf("装好的内容和市场目录里不一致：%v", err)
	}

	if r := app.InstallMarketPlugin("我的源"); r.Err != "" || r.InstalledID != "我的源" {
		t.Fatalf("装本地目录插件失败：%+v", r)
	}
	if k, _ := app.PluginKind("我的源"); k != "mygo" {
		t.Fatalf("目录插件应记成 mygo，得到 %q", k)
	}
	// 装完再列，installed 标记要亮
	items, _ = app.PluginMarket()
	for _, it := range items {
		if it.ID == "街角电台" && !it.Installed {
			t.Fatalf("装好的插件在市场里应显示为已安装")
		}
	}

	// 路径不能越界：市场目录里的 .. 名字不该被扫出来
	if _, err := os.Stat(pluginKindsPath()); err != nil {
		t.Fatalf("类型记录应落盘：%v", err)
	}
}
