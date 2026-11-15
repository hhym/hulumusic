package main

import (
	"github.com/egoist/mygo"
)

// 右键菜单中文。
//
// WebView2 自带的右键菜单是 Runtime 自己的英文界面（Back / Refresh /
// Save as / Print / Send tab to your devices / Inspect），跟随 WebView2
// 的 UI 语言，改 `--lang` 也未必能翻，而且跟播放器风格完全不搭。
// 这里在菜单弹出前把每一项的标签换成中文：MyGo 在 Windows 上会把被改过
// 的菜单自己画出来，WebView2 的动作照旧生效，只是文字变成中文。
func installChineseContextMenu(win *mygo.Window) {
	win.Page().OnContextMenu(func(e *mygo.ContextMenuEvent) {
		if e.Menu == nil {
			return
		}
		for _, it := range e.Menu.Items() {
			if it == nil || it.Label == "" {
				continue
			}
			if zh := zhMenuItem(it.ID, it.Label); zh != "" {
				it.Label = zh
			}
		}
	})
}

// 已知 ID（MyGo 归一化过的那些）优先，其次按平台给的英文原文兜底。
func zhMenuItem(id, label string) string {
	if zh, ok := zhByID[id]; ok {
		return zh
	}
	if zh, ok := zhByLabel[label]; ok {
		return zh
	}
	return ""
}

var zhByID = map[string]string{
	mygo.ContextMenuBack:                 "后退",
	mygo.ContextMenuForward:              "前进",
	mygo.ContextMenuReload:               "刷新",
	mygo.ContextMenuStop:                 "停止加载",
	mygo.ContextMenuInspect:              "检查元素（开发者工具）",
	mygo.ContextMenuUndo:                 "撤销",
	mygo.ContextMenuRedo:                 "重做",
	mygo.ContextMenuCut:                  "剪切",
	mygo.ContextMenuCopy:                 "复制",
	mygo.ContextMenuPaste:                "粘贴",
	mygo.ContextMenuPasteAndMatchStyle:   "粘贴为纯文本",
	mygo.ContextMenuDelete:               "删除",
	mygo.ContextMenuSelectAll:            "全选",
	mygo.ContextMenuOpenLink:             "打开链接",
	mygo.ContextMenuOpenLinkInNewWindow:  "在新窗口打开链接",
	mygo.ContextMenuDownloadLink:         "下载链接目标",
	mygo.ContextMenuCopyLink:             "复制链接地址",
	mygo.ContextMenuOpenImageInNewWindow: "在新窗口打开图片",
	mygo.ContextMenuDownloadImage:        "保存图片",
	mygo.ContextMenuCopyImage:            "复制图片",
	mygo.ContextMenuCopyImageURL:         "复制图片地址",
	mygo.ContextMenuOpenFrameInNewWindow: "在新窗口打开框架",
	mygo.ContextMenuOpenMediaInNewWindow: "在新窗口打开媒体",
	mygo.ContextMenuDownloadMedia:        "保存媒体",
	mygo.ContextMenuCopyMediaURL:         "复制媒体地址",
	mygo.ContextMenuMediaControls:        "显示播放控件",
	mygo.ContextMenuMediaLoop:            "循环播放",
	mygo.ContextMenuMediaFullScreen:      "全屏",
	mygo.ContextMenuPictureInPicture:     "画中画",
	mygo.ContextMenuLookUp:               "查询",
	mygo.ContextMenuSearchWeb:            "使用搜索引擎搜索",
	mygo.ContextMenuShare:                "分享",
	mygo.ContextMenuEmoji:                "表情符号",
	mygo.ContextMenuPrint:                "打印",
}

// WebView2 用的是自己的英文文案，ID 也不一定对应上面的常量，
// 所以再按原文兜一层（含它自己那几个播放器里用不上的菜单项）。
var zhByLabel = map[string]string{
	"Back":                        "后退",
	"Forward":                     "前进",
	"Refresh":                     "刷新",
	"Reload":                      "刷新",
	"Stop":                        "停止加载",
	"Save as":                     "另存为",
	"Save page as":                "另存网页",
	"Save image as":               "保存图片",
	"Save video as":               "保存视频",
	"Save audio as":               "保存音频",
	"Print":                       "打印",
	"Send tab to your devices":    "发送此页到我的其他设备",
	"Send page to your devices":   "发送此页到我的其他设备",
	"Inspect":                     "检查元素（开发者工具）",
	"Undo":                        "撤销",
	"Redo":                        "重做",
	"Cut":                         "剪切",
	"Copy":                        "复制",
	"Paste":                       "粘贴",
	"Paste as plain text":         "粘贴为纯文本",
	"Delete":                      "删除",
	"Select all":                  "全选",
	"Select All":                  "全选",
	"Open link":                   "打开链接",
	"Open link in new window":     "在新窗口打开链接",
	"Open link in new tab":        "在新标签页打开链接",
	"Copy link":                   "复制链接地址",
	"Copy link address":           "复制链接地址",
	"Copy image":                  "复制图片",
	"Copy image address":          "复制图片地址",
	"Copy image URL":              "复制图片地址",
	"Open image in new window":    "在新窗口打开图片",
	"Open image in new tab":       "在新标签页打开图片",
	"Open media in new window":    "在新窗口打开媒体",
	"Copy media address":          "复制媒体地址",
	"Copy media URL":              "复制媒体地址",
	"Show controls":               "显示播放控件",
	"Loop":                        "循环播放",
	"Full screen":                 "全屏",
	"Picture in picture":          "画中画",
	"Look up":                     "查询",
	"Search the web":              "使用搜索引擎搜索",
	"Search web":                  "使用搜索引擎搜索",
	"Share":                       "分享",
	"Emoji":                       "表情符号",
	"Add to dictionary":           "添加到词典",
	"Translate":                   "翻译",
	"Translate selection":         "翻译选中内容",
	"Create QR code for this page": "生成本页二维码",
	"Web capture":                 "网页截图",
	"Read aloud":                  "朗读",
	"More tools":                  "更多工具",
}
