package qianqian

import "testing"

func TestDecodeSkinFile(t *testing.T) {
	skin, err := decodeSkinFile("testdata/winamp-modern.skn")
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if skin.Name == "" {
		t.Fatal("没有解析到皮肤名")
	}
	if len(skin.Windows) == 0 {
		t.Fatal("没有解析到窗口")
	}
	var player *TtSkinWindow
	for i := range skin.Windows {
		if skin.Windows[i].Name == "player" {
			player = &skin.Windows[i]
		}
	}
	if player == nil {
		t.Fatalf("缺少 player 窗口，实际窗口: %v", skin.Windows)
	}
	if len(player.Controls) < 8 {
		t.Fatalf("player 控件太少: %d", len(player.Controls))
	}
	if len(skin.Assets) < 20 {
		t.Fatalf("贴图太少: %d", len(skin.Assets))
	}
	// 关键控件必须在，且坐标不能是 0,0,0,0
	for _, want := range []string{"play", "next", "progress", "volume"} {
		found := false
		for _, c := range player.Controls {
			if c.Name == want {
				found = true
				if c.X2 == 0 {
					t.Fatalf("%s 控件坐标缺失", want)
				}
			}
		}
		if !found {
			t.Fatalf("缺少 %s 控件", want)
		}
	}
	t.Logf("%s / %s：%d 个窗口，player 有 %d 个控件，%d 个贴图",
		skin.Name, skin.Author, len(skin.Windows), len(player.Controls), len(skin.Assets))
}
