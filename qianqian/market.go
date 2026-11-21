package qianqian

import (
	"embed"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
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
	// 本地市场目录里的条目：Kind 为 mygo / musicfree，Path 是那份插件所在的绝对路径，
	// Source 标一下来源（builtin = 打包进 exe，local = 用户放进市场目录的）
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Source string `json:"source"`
}

// ---------- 本地插件市场目录 ----------
//
// 内嵌清单管不了用户自己攒的插件：想让「点一下就装好」覆盖这些，就把插件丢进市场
// 目录里——MyGo 是一个个插件文件夹，MusicFree 是 .js 单文件——刷新清单即可出现，
// 点安装走和本地导入完全相同的 installPluginDir / installPluginJS。

func marketDirsPath() string { return filepath.Join(dataDir(), "market-dirs.json") }

// defaultMarketDir 是内置的默认市场目录，第一次用会建成空文件夹。
func defaultMarketDir() string {
	dir := filepath.Join(dataDir(), "plugin-market")
	os.MkdirAll(dir, 0o755)
	return dir
}

func loadExtraMarketDirs() []string {
	var dirs []string
	if b, err := os.ReadFile(marketDirsPath()); err == nil {
		json.Unmarshal(b, &dirs)
	}
	return dirs
}

func saveExtraMarketDirs(dirs []string) error {
	b, _ := json.MarshalIndent(dirs, "", "  ")
	return os.WriteFile(marketDirsPath(), b, 0o644)
}

// allMarketDirs 返回要扫的市场目录：默认目录在前，用户添加的在后（去重）。
func allMarketDirs() []string {
	out := []string{defaultMarketDir()}
	seen := map[string]bool{out[0]: true}
	for _, d := range loadExtraMarketDirs() {
		d = strings.TrimSpace(d)
		if d == "" || seen[d] {
			continue
		}
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			continue
		}
		seen[d] = true
		out = append(out, d)
	}
	return out
}

// MarketDir 把默认市场目录告诉前端，界面上能显示路径。
func (a *App) MarketDir() (string, string) { return defaultMarketDir(), "" }

// OpenMarketDir 在资源管理器里打开默认市场目录，用户直接把插件丢进去。
func (a *App) OpenMarketDir() (string, string) {
	dir := defaultMarketDir()
	if err := openInExplorer(dir); err != nil {
		return dir, "打不开目录：" + err.Error()
	}
	return dir, ""
}

// AddMarketDir 弹目录选择，把用户挑的目录加进市场来源。
func (a *App) AddMarketDir() PickResult {
	if a.ctx == nil {
		return PickResult{Plugins: a.scanPlugins(), Err: "窗口还没就绪"}
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:    a.win,
		Title:     "选择插件市场目录（里面放插件文件夹或 .js）",
		Directory: true,
	})
	if err != nil {
		return PickResult{Plugins: a.scanPlugins(), Err: err.Error()}
	}
	if len(paths) == 0 || paths[0] == "" {
		return PickResult{Plugins: a.scanPlugins(), Canceled: true}
	}
	dir := filepath.Clean(paths[0])
	dirs := loadExtraMarketDirs()
	for _, d := range dirs {
		if filepath.Clean(d) == dir {
			return PickResult{Plugins: a.scanPlugins(), InstalledID: ""}
		}
	}
	dirs = append(dirs, dir)
	if err := saveExtraMarketDirs(dirs); err != nil {
		return PickResult{Plugins: a.scanPlugins(), Err: "记不住这个目录：" + err.Error()}
	}
	return PickResult{Plugins: a.scanPlugins()}
}

// scanLocalMarket 扫市场目录：子文件夹按 MyGo 目录型插件算，.js 文件按 MusicFree 算。
func scanLocalMarket(installed map[string]bool) []MarketItem {
	out := []MarketItem{}
	for _, dir := range allMarketDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			if e.IsDir() {
				b, rerr := os.ReadFile(filepath.Join(dir, name, "plugin.json"))
				if rerr != nil {
					continue // 没有 plugin.json 就不是插件文件夹，跳过
				}
				var m PluginManifest
				if json.Unmarshal(b, &m) != nil {
					continue
				}
				id := sanitizeID(strings.TrimSpace(m.ID))
				if id == "" {
					id = sanitizeID(name)
				}
				if !safePluginID(id) {
					continue
				}
				title := m.Name
				if title == "" {
					title = id
				}
				out = append(out, MarketItem{
					ID:          id,
					Name:        title,
					Version:     m.Version,
					Author:      m.Author,
					Description: m.Description,
					Tags:        []string{"本地"},
					Size:        dirSizeOS(filepath.Join(dir, name)),
					Installed:   installed[id],
					Kind:        "mygo",
					Path:        filepath.Join(dir, name),
					Source:      "local",
				})
				continue
			}
			if !strings.HasSuffix(strings.ToLower(name), ".js") {
				continue
			}
			id := sanitizeFileID(strings.TrimSuffix(name, filepath.Ext(name)))
			if id == "" || !safePluginID(id) {
				continue
			}
			title, ver := id, ""
			size := int64(0)
			if fi, ierr := e.Info(); ierr == nil {
				size = fi.Size()
			}
			if b, rerr := os.ReadFile(filepath.Join(dir, name)); rerr == nil {
				title, ver = musicFreeMeta(string(b))
			}
			if title == "" {
				title = id
			}
			out = append(out, MarketItem{
				ID:          id,
				Name:        title,
				Version:     ver,
				Description: "MusicFree 单文件插件（放在市场目录里）",
				Tags:        []string{"本地"},
				Size:        size,
				Installed:   installed[id],
				Kind:        "musicfree",
				Path:        filepath.Join(dir, name),
				Source:      "local",
			})
		}
	}
	return out
}

// dirSizeOS 算一个真实目录的体积（内置插件包用的是 dirSize(fs.FS)）。
func dirSizeOS(root string) int64 {
	var n int64
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			n += info.Size()
		}
		return nil
	})
	return n
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
	// 用户在市场目录里放的插件排在前面：那是他刚丢进去、最想装的
	seen := map[string]bool{}
	for _, it := range scanLocalMarket(installed) {
		if seen[it.ID] {
			continue
		}
		seen[it.ID] = true
		items = append(items, it)
	}
	for _, it := range raw {
		if strings.TrimSpace(it.ID) == "" || seen[it.ID] {
			continue
		}
		if _, err := fs.Stat(builtinPlugins, "builtin/plugins/"+it.ID); err != nil {
			continue // 清单里有、包里没有，不列出来，免得点了装不上
		}
		it.Installed = installed[it.ID]
		seen[it.ID] = true
		it.Source = "builtin"
		it.Kind = "mygo"
		if it.Size == 0 {
			it.Size = dirSize(builtinPlugins, "builtin/plugins/"+it.ID)
		}
		items = append(items, it)
	}
	return items, ""
}

// InstallMarketPlugin 把内置插件包铺到数据目录，返回装好后的插件列表。
func (a *App) InstallMarketPlugin(id string) PickResult {
	id = sanitizeID(strings.TrimSpace(id))
	if id == "" {
		return PickResult{Plugins: a.scanPlugins(), Err: "插件 id 是空的"}
	}
	// 先看市场目录里的本地插件（用户自己攒的），没有再回落到内嵌插件包
	for _, it := range scanLocalMarket(map[string]bool{}) {
		if it.ID != id {
			continue
		}
		switch it.Kind {
		case "musicfree":
			b, rerr := os.ReadFile(it.Path)
			if rerr != nil {
				return PickResult{Plugins: a.scanPlugins(), Err: "读不到插件：" + rerr.Error()}
			}
			nid, ierr := a.installPluginJS(filepath.Base(it.Path), b)
			if ierr != nil {
				return PickResult{Plugins: a.scanPlugins(), Err: ierr.Error()}
			}
			return PickResult{Plugins: a.scanPlugins(), InstalledID: nid}
		default:
			nid, ierr := a.installPluginDir(it.Path)
			if ierr != nil {
				return PickResult{Plugins: a.scanPlugins(), Err: ierr.Error()}
			}
			return PickResult{Plugins: a.scanPlugins(), InstalledID: nid}
		}
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
