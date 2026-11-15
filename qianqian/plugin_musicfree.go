package qianqian

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

/* MusicFree 单文件插件。

   MusicFree 插件就是一个 .js：`module.exports = { platform, version, search,
   getMediaSource, getLyric, … }`，内部用 require('axios') / require('cheerio')。
   它和 MyGo 的目录型插件是两套规范，但落到磁盘上都是「插件目录里的一个文件」，
   所以状态、启停、删除、播放链路全部复用，后端这里只额外负责：

     1. 把 .js 落盘成 plugins/<id>.js（id 由文件名或 platform 推出来）；
     2. 扫描时把它报成 kind=musicfree，前端据此换一套加载方式；
     3. 从源码里挖 platform / version / author，插件列表才有名字可显示。

   真正执行仍在前端（WebView），因为要垫 require('axios') 并把请求转到后端。 */

var (
	// platform: '网易云'  /  platform: "QQ音乐"
	mfPlatformRe = regexp.MustCompile(`platform\s*[:=]\s*['"\x60]([^'"\x60]{1,40})['"\x60]`)
	// version: '0.1.2'
	mfVersionRe = regexp.MustCompile(`version\s*[:=]\s*['"\x60]([^'"\x60]{1,20})['"\x60]`)
	// author: 'xxx' / author: { name: 'xxx' }
	mfAuthorRe = regexp.MustCompile(`author\s*[:=]\s*['"\x60]([^'"\x60]{1,40})['"\x60]`)
	// srcUrl 之类的说明字段，拿来当简介
	mfDescRe = regexp.MustCompile(`(?:description|desc|srcUrl)\s*[:=]\s*['"\x60]([^'"\x60]{1,120})['"\x60]`)
	// 判断是不是 MusicFree 插件（MyGo 插件是 export function，不会出现 module.exports）
	mfMarkerRe = regexp.MustCompile(`module\.exports|exports\.[A-Za-z_]+\s*=`)
)

// mfIsPlugin 粗判一段源码是不是 MusicFree 插件。
func mfIsPlugin(code string) bool {
	return mfMarkerRe.MatchString(code)
}

// mfIDFrom 从文件名或 platform 推一个可用的插件 id。
func mfIDFrom(hint, code string) string {
	base := strings.TrimSuffix(filepath.Base(strings.TrimSpace(hint)), filepath.Ext(hint))
	id := sanitizeID(base)
	if m := mfPlatformRe.FindStringSubmatch(code); len(m) > 1 {
		if pid := sanitizeID(m[1]); pid != "" && id == "" {
			id = "mf-" + pid
		}
	}
	if id == "" {
		id = "mf-plugin"
	}
	return id
}

// installMFPlugin 把 MusicFree 单文件插件落盘并默认启用。
func (a *App) installMFPlugin(code, idHint string) (string, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return "", fmt.Errorf("插件内容是空的")
	}
	if !mfIsPlugin(code) {
		return "", fmt.Errorf("这不像 MusicFree 插件：要写成 module.exports = { platform, search, getMediaSource … }")
	}
	// 插件体积有个上限：正常 MusicFree 插件几十 KB，几 MB 的多半是打包错了
	if len(code) > 4<<20 {
		return "", fmt.Errorf("插件太大（%d 字节），正常的 MusicFree 单文件插件不会超过几 MB", len(code))
	}
	id := mfIDFrom(idHint, code)
	if !safePluginID(id) {
		return "", fmt.Errorf("插件 id 不合法：%q", id)
	}
	os.MkdirAll(pluginsDir(), 0o755)
	dst := filepath.Join(pluginsDir(), id+".js")
	if err := os.WriteFile(dst, []byte(code), 0o644); err != nil {
		return "", err
	}
	state := loadPluginState()
	state[id] = true
	savePluginState(state)
	return id, nil
}

// mfMeta 读单文件插件的元信息。只读前 8KB：platform 之类都在文件头。
func mfMeta(id string) (name, version, author, desc string) {
	b, err := os.ReadFile(filepath.Join(pluginsDir(), id+".js"))
	if err != nil {
		return id, "", "", "MusicFree 插件"
	}
	head := string(b)
	if len(head) > 8192 {
		head = head[:8192]
	}
	if m := mfPlatformRe.FindStringSubmatch(head); len(m) > 1 {
		name = strings.TrimSpace(m[1])
	}
	if m := mfVersionRe.FindStringSubmatch(head); len(m) > 1 {
		version = strings.TrimSpace(m[1])
	}
	if m := mfAuthorRe.FindStringSubmatch(head); len(m) > 1 {
		author = strings.TrimSpace(m[1])
	}
	if m := mfDescRe.FindStringSubmatch(head); len(m) > 1 {
		desc = strings.TrimSpace(m[1])
	}
	if name == "" {
		name = id
	}
	if desc == "" {
		desc = "MusicFree 插件"
	}
	return
}

// scanSingleFilePlugins 列出 pluginsDir 下的单文件插件（*.js → MusicFree）。
func scanSingleFilePlugins(state map[string]bool) []Plugin {
	dir := pluginsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []Plugin{}
	}
	out := make([]Plugin, 0, 8)
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".js") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		if !safePluginID(id) {
			continue
		}
		name, ver, author, desc := mfMeta(id)
		fi, _ := e.Info()
		var size int64
		installed := ""
		if fi != nil {
			size = fi.Size()
			installed = fi.ModTime().Format("2006-01-02 15:04")
		}
		out = append(out, Plugin{
			ID:          id,
			Name:        name,
			Version:     ver,
			Author:      author,
			Description: desc,
			Enabled:     state[id],
			Compatible:  true,
			Size:        size,
			InstalledAt: installed,
			File:        id + ".js",
			Kind:        "musicfree",
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
