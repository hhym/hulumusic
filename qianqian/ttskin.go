package qianqian

// 千千静听 .skn 皮肤兼容层（插件侧解码）。
//
// .skn 是 ZIP：内含 Skin.xml（布局）+ PlayList.xml + Lyric.xml + 若干 BMP。
// 这里把「插件目录里的 .skn」解析成前端能直接渲染的模型：
//   - 控件：名字 + 四元组矩形 + 各态贴图
//   - 贴图：BMP 原样转 data URI（浏览器原生支持 BMP，不额外解码，省掉一层失真）
//
// 插件形态：目录型插件，plugin.json 里写 `"kind": "skin"`，同目录（或 skins/ 子目录）
// 放若干个 .skn。音源类插件（kind=mygo/musicfree）不受影响。

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

// TtSkinControl 是 Skin.xml 里的一个控件（按钮 / 滑杆 / 文本区 …）。
type TtSkinControl struct {
	Name       string `json:"name"` // play / volume / progress / lyric …
	X1         int    `json:"x1"`
	Y1         int    `json:"y1"`
	X2         int    `json:"x2"`
	Y2         int    `json:"y2"`
	Image      string `json:"image,omitempty"`      // 常态贴图
	HotImage   string `json:"hotImage,omitempty"`   // 悬停贴图
	ThumbImage string `json:"thumbImage,omitempty"` // 滑杆滑块
	FillImage  string `json:"fillImage,omitempty"`  // 进度填充
	BarImage   string `json:"barImage,omitempty"`   // 滑轨
	Color      string `json:"color,omitempty"`
	Bkgnd      string `json:"bkgnd,omitempty"`
	Font       string `json:"font,omitempty"`
	FontSize   int    `json:"fontSize,omitempty"`
	Align      string `json:"align,omitempty"`
	Vertical   bool   `json:"vertical,omitempty"`
}

// TtSkinWindow 是一个窗口（主窗口 / 迷你 / 歌词 / 均衡器 / 播放列表）。
type TtSkinWindow struct {
	Name     string          `json:"name"` // player / mini / lyric / equalizer / playlist
	Image    string          `json:"image"`
	X        int             `json:"x"`
	Y        int             `json:"y"`
	W        int             `json:"w"`
	H        int             `json:"h"`
	Controls []TtSkinControl `json:"controls"`
}

// TtSkin 是一套皮肤。
type TtSkin struct {
	File        string            `json:"file"`
	Name        string            `json:"name"`
	Author      string            `json:"author"`
	Homepage    string            `json:"homepage"`
	Transparent string            `json:"transparent"` // 抠色，形如 #ff00ff
	Windows     []TtSkinWindow    `json:"windows"`
	Assets      map[string]string `json:"assets"` // 文件名 → data:image/bmp;base64,…
}

// TtSkinPack 是一个皮肤插件包。
type TtSkinPack struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Author  string   `json:"author"`
	Skins   []TtSkin `json:"skins"`
}

// skinManifest 只关心皮肤插件需要的字段，和音源插件共用 plugin.json。
type skinManifest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Author  string `json:"author"`
	Kind    string `json:"kind"`
}

// isSkinDir 判断一个插件目录是不是皮肤插件：plugin.json 里 kind=skin，
// 或者目录里直接躺着 .skn（老式手工放进来的也能认）。
func isSkinDir(dir string) (skinManifest, bool) {
	var m skinManifest
	if b, err := os.ReadFile(filepath.Join(dir, "plugin.json")); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	if strings.EqualFold(m.Kind, "skin") {
		return m, true
	}
	if hasSkn(dir) {
		if m.ID == "" {
			m.ID = filepath.Base(dir)
		}
		if m.Name == "" {
			m.Name = m.ID
		}
		m.Kind = "skin"
		return m, true
	}
	return m, false
}

func hasSkn(dir string) bool {
	for _, sub := range []string{"", "skins", "skin"} {
		matches, _ := filepath.Glob(filepath.Join(dir, sub, "*.skn"))
		if len(matches) > 0 {
			return true
		}
	}
	return false
}

func sknFiles(dir string) []string {
	var out []string
	for _, sub := range []string{"", "skins", "skin"} {
		matches, _ := filepath.Glob(filepath.Join(dir, sub, "*.skn"))
		out = append(out, matches...)
	}
	sort.Strings(out)
	return out
}

// SkinPacks 列出所有皮肤插件（只解析清单，不解压贴图，够列表用）。
func (a *App) SkinPacks() ([]TtSkinPack, error) {
	entries, err := os.ReadDir(pluginsDir())
	if err != nil {
		return nil, err
	}
	var out []TtSkinPack
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(pluginsDir(), e.Name())
		m, ok := isSkinDir(dir)
		if !ok {
			continue
		}
		pack := TtSkinPack{ID: m.ID, Name: m.Name, Version: m.Version, Author: m.Author}
		for _, f := range sknFiles(dir) {
			// 列表阶段只报文件名，贴图等打开时再解。
			if meta, err := readSkinMeta(f); err == nil {
				pack.Skins = append(pack.Skins, meta)
			} else {
				pack.Skins = append(pack.Skins, TtSkin{File: filepath.Base(f), Name: filepath.Base(f)})
			}
		}
		if len(pack.Skins) > 0 {
			out = append(out, pack)
		}
	}
	return out, nil
}

// readSkinMeta 只读 Skin.xml 的头几个属性（不解贴图）。
func readSkinMeta(path string) (TtSkin, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return TtSkin{}, err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if !strings.EqualFold(filepath.Base(f.Name), "skin.xml") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return TtSkin{}, err
		}
		raw, _ := io.ReadAll(io.LimitReader(rc, 2<<20))
		rc.Close()
		skin, err := parseSkinXML(bytes.NewReader(toUTF8(raw)))
		if err != nil {
			return TtSkin{}, err
		}
		skin.File = filepath.Base(path)
		// 列表只要名字，窗口/贴图丢掉，避免每次刷新列表都传几 MB。
		skin.Windows = nil
		return skin, nil
	}
	return TtSkin{File: filepath.Base(path)}, fmt.Errorf("缺少 Skin.xml")
}

// DecodeSkinPack 把一个皮肤插件的全部 .skn 解成全量模型（含贴图 data URI）。
func (a *App) DecodeSkinPack(id string) (TtSkinPack, error) {
	if !safePluginID(id) {
		return TtSkinPack{}, fmt.Errorf("非法插件 id")
	}
	dir := filepath.Join(pluginsDir(), id)
	m, ok := isSkinDir(dir)
	if !ok {
		return TtSkinPack{}, fmt.Errorf("不是皮肤插件：%s", id)
	}
	pack := TtSkinPack{ID: m.ID, Name: m.Name, Version: m.Version, Author: m.Author}
	for _, f := range sknFiles(dir) {
		skin, err := decodeSkinFile(f)
		if err != nil {
			continue
		}
		pack.Skins = append(pack.Skins, skin)
	}
	if len(pack.Skins) == 0 {
		return TtSkinPack{}, fmt.Errorf("插件里没有可用的 .skn")
	}
	return pack, nil
}

// decodeSkinFile 解压一个 .skn：Skin.xml → 模型，*.bmp → data URI。
func decodeSkinFile(path string) (TtSkin, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return TtSkin{}, err
	}
	defer zr.Close()

	skin := TtSkin{File: filepath.Base(path)}
	assets := map[string]string{} // 单独存：XML 可能在 BMP 之后才出现，不能被覆盖
	var loadedXML bool
	for _, f := range zr.File {
		base := filepath.Base(f.Name)
		if f.FileInfo().IsDir() {
			continue
		}
		switch {
		case strings.EqualFold(base, "skin.xml"):
			rc, err := f.Open()
			if err != nil {
				continue
			}
			raw, _ := io.ReadAll(io.LimitReader(rc, 2<<20))
			rc.Close()
			parsed, err := parseSkinXML(bytes.NewReader(toUTF8(raw)))
			if err == nil {
				parsed.File = skin.File
				skin = parsed
				loadedXML = true
			}
		case strings.EqualFold(filepath.Ext(base), ".bmp"):
			rc, err := f.Open()
			if err != nil {
				continue
			}
			data, _ := io.ReadAll(io.LimitReader(rc, 8<<20))
			rc.Close()
			if len(data) > 0 {
				assets[base] = "data:image/bmp;base64," + base64.StdEncoding.EncodeToString(data)
			}
		}
	}
	skin.Assets = assets
	if !loadedXML {
		return skin, fmt.Errorf("缺少 Skin.xml")
	}
	return skin, nil
}

// parseSkinXML 用流式 XML 解析：控件名就是标签名，属性各自取，
// 这样皮肤里加/减控件都不用改结构体。
func parseSkinXML(r io.Reader) (TtSkin, error) {
	dec := xml.NewDecoder(r)
	dec.Strict = false
	dec.CharsetReader = func(_ string, input io.Reader) (io.Reader, error) { return input, nil }

	skin := TtSkin{Assets: map[string]string{}}
	var cur *TtSkinWindow
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			if len(skin.Windows) > 0 {
				break // XML 尾部偶有多余标签，已经解出窗口就不算失败
			}
			return skin, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := strings.ToLower(t.Name.Local)
			attrs := map[string]string{}
			for _, a := range t.Attr {
				attrs[strings.ToLower(a.Name.Local)] = a.Value
			}
			switch {
			case name == "skin":
				skin.Name = attrs["name"]
				skin.Author = attrs["author"]
				skin.Homepage = attrs["url"]
				skin.Transparent = attrs["transparent_color"]
			case strings.HasSuffix(name, "_window"):
				w := TtSkinWindow{
					Name:  strings.TrimSuffix(name, "_window"),
					Image: attrs["image"],
				}
				if p, ok := parseRect(attrs["position"]); ok {
					w.X, w.Y, w.W, w.H = p[0], p[1], p[2]-p[0], p[3]-p[1]
				}
				skin.Windows = append(skin.Windows, w)
				cur = &skin.Windows[len(skin.Windows)-1]
			case cur != nil:
				ctrl := TtSkinControl{
					Name:       name,
					Image:      attrs["image"],
					HotImage:   attrs["hot_image"],
					ThumbImage: attrs["thumb_image"],
					FillImage:  attrs["fill_image"],
					BarImage:   attrs["bar_image"],
					Color:      attrs["color"],
					Bkgnd:      attrs["bkgnd"],
					Font:       attrs["font"],
					Align:      attrs["align"],
					Vertical:   strings.EqualFold(attrs["vertical"], "true"),
				}
				if p, ok := parseRect(attrs["position"]); ok {
					ctrl.X1, ctrl.Y1, ctrl.X2, ctrl.Y2 = p[0], p[1], p[2], p[3]
				}
				if n, err := strconv.Atoi(attrs["font_size"]); err == nil {
					ctrl.FontSize = n
				}
				// 只有带坐标的才算控件；mini_border / scrollbar 这类局部元素跳过。
				if ctrl.X2 > 0 && ctrl.Y2 > 0 {
					cur.Controls = append(cur.Controls, ctrl)
				}
			}
		case xml.EndElement:
			if strings.HasSuffix(strings.ToLower(t.Name.Local), "_window") {
				cur = nil
			}
		}
	}
	return skin, nil
}

func parseRect(s string) ([4]int, bool) {
	var out [4]int
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// toUTF8 把皮肤 XML 的字节转成 UTF-8：老皮肤大多不带 encoding 声明，
// 中文作者名常是 GBK 裸字节，直接给 xml.Decoder 会判成非法 UTF-8 而整份失败。
func toUTF8(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	if dec, err := simplifiedchinese.GBK.NewDecoder().Bytes(b); err == nil && utf8.Valid(dec) {
		return dec
	}
	if dec, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), b); err == nil && utf8.Valid(dec) {
		return dec
	}
	return b
}
