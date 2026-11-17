package qianqian

import (
	"embed"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

/* 插件市场：清单与插件包都跟着 exe 走。

   qianqian/builtin/market.json   市场条目（id / name / version / author / description / tags / size）
   qianqian/builtin/plugins/<id>/  该条目的插件实体（plugin.json + index.js ...）

   「插件市场」页点安装 = 把内置目录整份复制到数据目录的 plugins/<id>/，
   之后走和本地导入完全相同的扫描逻辑。市场清单里没登记、或内置目录里没有对应 id 的，
   一切照旧返回提示，不让界面卡在「方法未绑定」上。 */

//go:embed builtin/market.json
var marketJSON []byte

//go:embed all:builtin/plugins
var builtinPlugins embed.FS

type MarketItem struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Author      string   `json:"author"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Size        int64    `json:"size"`
	Installed   bool     `json:"installed"`
}

// PluginMarket 返回内置市场清单（带已装标记）。第二个返回值是提示串：
// 清单为空时给一句人话，界面就不会只剩一个红字错误。
func (a *App) PluginMarket() ([]MarketItem, string) {
	items := []MarketItem{}
	var raw []MarketItem
	if err := json.Unmarshal(marketJSON, &raw); err != nil {
		return items, "内置市场清单解析失败：" + err.Error()
	}
	installed := map[string]bool{}
	for _, p := range a.scanPlugins() {
		installed[p.ID] = true
	}
	for _, it := range raw {
		if strings.TrimSpace(it.ID) == "" {
			continue
		}
		if _, err := fs.Stat(builtinPlugins, "builtin/plugins/"+it.ID); err != nil {
			continue // 清单里有、包里没有，不列出来，免得点了装不上
		}
		it.Installed = installed[it.ID]
		if it.Size == 0 {
			it.Size = dirSize(builtinPlugins, "builtin/plugins/"+it.ID)
		}
		items = append(items, it)
	}
	if len(items) == 0 {
		return items, "本安装包暂未内置插件市场条目，可往下用「选 zip / 选文件夹」导入本地插件"
	}
	return items, ""
}

// InstallMarketPlugin 把内置插件包铺到数据目录，返回装好后的插件列表。
func (a *App) InstallMarketPlugin(id string) PickResult {
	id = sanitizeID(strings.TrimSpace(id))
	if id == "" {
		return PickResult{Plugins: a.scanPlugins(), Err: "插件 id 是空的"}
	}
	src := "builtin/plugins/" + id
	if _, err := fs.Stat(builtinPlugins, src); err != nil {
		return PickResult{Plugins: a.scanPlugins(), Err: "安装包里没有这个插件：" + id}
	}
	dst := filepath.Join(pluginsDir(), id)
	if err := os.RemoveAll(dst); err != nil {
		return PickResult{Plugins: a.scanPlugins(), Err: "清空旧目录失败：" + err.Error()}
	}
	err := fs.WalkDir(builtinPlugins, src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(filepath.FromSlash(src), filepath.FromSlash(path))
		out := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(out, 0o755)
		}
		b, e := builtinPlugins.ReadFile(path)
		if e != nil {
			return e
		}
		if e := os.MkdirAll(filepath.Dir(out), 0o755); e != nil {
			return e
		}
		return os.WriteFile(out, b, 0o644)
	})
	if err != nil {
		return PickResult{Plugins: a.scanPlugins(), Err: "写入插件失败：" + err.Error()}
	}
	// 刚装的默认启用，否则用户装完还要手动点一次开关
	st := loadPluginState()
	st[id] = true
	savePluginState(st)
	return PickResult{Plugins: a.scanPlugins(), InstalledID: id}
}

// dirSize 估算内置插件目录体积，用于市场条目展示。
func dirSize(fsys fs.FS, root string) int64 {
	var n int64
	fs.WalkDir(fsys, root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, e := d.Info(); e == nil {
			n += info.Size()
		}
		return nil
	})
	return n
}
