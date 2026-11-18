package qianqian

import (
	"os"
	"path/filepath"
	"testing"
)

// 端到端：插件目录里放 kind=skin，扫描 → 列表 → 解码 都要通。
func TestSkinPluginFlow(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HULU_DATA_DIR", dir)
	plug := filepath.Join(dir, "plugins", "ttplayer-skins")
	if err := os.MkdirAll(filepath.Join(plug, "skins"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"ttplayer-skins","name":"千千静听皮肤","version":"1.0.0","kind":"skin"}`
	if err := os.WriteFile(filepath.Join(plug, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile("testdata/winamp-modern.skn")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plug, "skins", "Winamp Modern.skn"), src, 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. 插件列表里必须报 kind=skin（前端靠它把「试搜」换成「换肤」）
	var found bool
	for _, p := range scanMyGoPlugins(map[string]bool{"ttplayer-skins": true}) {
		if p.ID == "ttplayer-skins" {
			found = true
			if p.Kind != "skin" {
				t.Fatalf("kind 应为 skin，实际 %q", p.Kind)
			}
		}
	}
	if !found {
		t.Fatal("插件列表里没有皮肤插件")
	}

	a := &App{}
	packs, err := a.SkinPacks()
	if err != nil {
		t.Fatal(err)
	}
	if len(packs) != 1 || len(packs[0].Skins) != 1 {
		t.Fatalf("皮肤包不对: %+v", packs)
	}
	if packs[0].Skins[0].Name != "Winamp Modern" {
		t.Fatalf("皮肤名不对: %q", packs[0].Skins[0].Name)
	}

	pack, err := a.DecodeSkinPack("ttplayer-skins")
	if err != nil {
		t.Fatal(err)
	}
	if len(pack.Skins[0].Windows) == 0 || len(pack.Skins[0].Assets) == 0 {
		t.Fatal("解码结果为空")
	}
	t.Logf("插件 %s：%d 套皮肤，第一套 %s（%d 窗口 / %d 贴图）",
		pack.Name, len(pack.Skins), pack.Skins[0].Name, len(pack.Skins[0].Windows), len(pack.Skins[0].Assets))
}
