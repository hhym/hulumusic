# 千千静听 .skn 皮肤兼容层（插件形式）

## 结论

`.skn` 本质是 ZIP：`Skin.xml`（布局）+ `PlayList.xml` / `Lyric.xml` / `Visual.xml` + 若干 BMP。
所以兼容层不需要逆向二进制，只要「解析 XML 坐标 + 把 BMP 贴回去」，17 套皮肤全部可以
按原样还原（已在 `皮肤渲染校验.png` 里逐套验证）。

落成三块：

| 层 | 文件 | 干什么 |
|---|---|---|
| 插件形态 | `plugins/ttplayer-skins/plugin.json` + `skins/*.skn` | 皮肤以插件分发，`kind: "skin"` |
| Go 解码 | `qianqian/ttskin.go` | 扫插件目录、解 ZIP、XML→模型、BMP→data URI |
| 前端渲染 | `web/src/ttskin.ts` | 抠品红透明、按四元组绝对定位、生成 CSS 主题 |

## 插件包规范

```
plugins/
└── ttplayer-skins/
    ├── plugin.json          # id / name / version / kind:"skin"
    └── skins/
        ├── Default.skn
        ├── Winamp Modern.skn
        └── ...
```

`plugin.json`：

```json
{
  "id": "ttplayer-skins",
  "name": "千千静听皮肤",
  "version": "1.0.0",
  "kind": "skin",
  "author": "TTPlayer 官方皮肤包",
  "minAppVersion": "3.0.0",
  "skins": ["skins/Default.skn", "skins/Winamp Modern.skn"]
}
```

扫描规则（`isSkinDir`）：`plugin.json` 里 `kind == "skin"`，**或**目录里直接躺着 `*.skn`
（`skins/`、`skin/`、根目录三处都扫）。音源插件的 `kind` 不在枚举里，改成"有 .skn 就认"，
老的手工安装包也能用。安装走现有 `InstallPluginFile`（zip / 目录都行），不额外校验 kind。

## Skin.xml 要点（踩过的坑）

- `position="x1,y1,x2,y2"` 是**端点矩形**，宽 = x2-x1，不是宽高。
- `transparent_color`（多为 `#ff00ff`）是颜色键，浏览器不支持颜色键，必须 canvas 逐像素抠。
  **背景图和按钮图都要抠**，只抠按钮会在窗口边缘留品红边。
- `_window` 里只有 `<player_window>` 没有 `position`（尺寸取背景图）；`lyric/equalizer/playlist/mini`
  的 `position` 是窗口在屏幕上的位置与尺寸。
- 编码：老皮肤 `Skin.xml` 常是**无声明的 GBK 裸字节**（中文作者名），`encoding/xml` 直接判非法
  UTF-8 整份失败 → `toUTF8()` 用 `x/text` 的 GBK/GB18030 兜底。
- 语法：部分皮肤有**未加引号的属性**（`interval=4`），Go 的 `xml.Decoder{Strict:false}` 能过；
  Python/浏览器侧的 XML 解析器要自己补引号。
- 控件名是标签名（play/pause/stop/prev/next/mute/open/progress/volume/led/stereo/status/info/visual…），
  流式解析不要用固定结构体，皮肤之间控件差异很大。
- `progress`/`volume`/`balance` 是滑杆：`thumb_image` 滑块、`fill_image` 填充、`bar_image` 轨道、
  `vertical` 方向；`led` 的 `number.bmp` 是整条数字带，要按位移滚动，不能当普通贴图铺。

## 换肤入口（已接进插件页）

皮肤插件在「插件」页的卡片上不再显示「试搜」，换成「换肤」；点开是一个 17 套皮肤的缩略图
网格（缩略图就是渲染器按 156px 等比缩出来的真实窗口），点一套立刻换，另有「恢复内置」。

链路：

1. Go `scanMyGoPlugins` 把 `kind` 从固定 `mygo` 改成按目录判定 —— 目录里有 `.skn` 就报 `skin`；
2. `Plugins.tsx` 按 `p.kind === "skin"` 分流：按钮文案、跳搜索面板、跳换肤面板；
3. `ttskin.ts` 注入 `[data-skin="ttskn-xxx"]` 的 CSS，并派发 `hulu-skin-changed` 事件；
4. `App.tsx` 监听该事件，把 `data-skin={ttSkin || skinTheme}`，手动切内置皮肤时清掉插件皮肤；
5. `activePlugins()` 过滤掉 `kind === "skin"` —— 皮肤插件没有 search 导出，混进音源会一搜就报错。

## 前端接入（最小改动）

```ts
import {loadSkinPacks, decodeSkinPack, renderTtSkinWindow, activateTtSkin} from './ttskin'

// 1. 皮肤列表
const packs = await loadSkinPacks()          // → [{id:"ttplayer-skins", skins:[{file,name},…]}]
// 2. 取全量（含贴图）
const pack = await decodeSkinPack('ttplayer-skins')
// 3a. 主题映射：把皮肤配色/底图套到现有 .skin 界面（改 data-skin，不动布局）
await activateTtSkin(pack.skins[0])
// 3b. 像素级还原：把千千静听窗口原样画出来（按钮可点）
const dispose = renderTtSkinWindow(el, pack.skins[0], 'player', {
  onControl: name => ({play: toggle, next: nextTrack, prev: prevTrack} as any)[name]?.(),
})
```

`renderTtSkinWindow` 返回清理函数，切换皮肤/卸载时调用即可；渲染是纯 DOM + 绝对定位，
不进 React 状态，所以不影响现有播放逻辑。

## 完成度

- Go：`go build ./...` 通过；`go test ./qianqian -run TestDecodeSkinFile` 通过。
- 17 套皮肤全量解码：`Default 5 窗口/22 控件/46 贴图` … `银色城堡 6/22/76`，0 失败。
- 前端：`tsc --noEmit` 通过。


## TT 模式（像素级千千静听窗口）

皮肤界面下多一层视图：主窗口按 `Skin.xml` 原样画，和皮肤包里的贴图一一对应。

- 入口：皮肤标题栏的 `TT` 按钮（`openTtMode()`），状态存 `qqjt-ttmode`；
- 组件：`web/src/TtSkinView.tsx`，纯 React 渲染（不是二次叠加），所以按钮状态是活的；
- 回退：窗口里点 `退出 TT 模式`，或皮肤界面左上角的布局按钮。

实现上踩过的四个坑：

1. **按钮贴图是多帧的**：`[常态/悬停/按下]` 常常横排或竖排拼在一张 BMP 里。
   先量贴图尺寸，再按控件矩形算帧数（能整除才算多帧），否则整图铺进一个 17×19 的按钮，
   看起来就是一片噪点——第一版就是这个症状。
2. **`led` 的 `number.bmp` 是 12 个字形**（0-9、`: `、`-`），按 `1/12` 位移取字；
   宽度量不出来才退回等宽文本。
3. **`progress`/`volume` 的 `thumb_image` 常是整条滑轨图**，直接按宽度铺会被拉变形，
   现在按 `auto 100%` 贴，位置跟着比例走。
4. **频谱区没有真实数据**：千千静听那块是 FFT，这里先用播放状态驱动的动态条带占位，
   颜色取 `stereo` 控件的 `color`（默认绿）。

已验证三套（截图 `tt模式-像素窗口.png`）：Default（270×168）、Winamp Modern（290×145）、
TT2012（327×157），按钮、进度、LED 时间、信息条位置都对得上原版。

### 已接功能

主窗口：`play/pause`（共用一张图，按播放状态换帧）、`stop`、`prev`、`next`、`mute`、
`minimize`/`minimode`（进迷你窗）、`exit`（退出 TT 模式）、`progress`（拖动跳转）、
`volume`（拖动调音量）。

`open/browser/lyric/equalizer/playlist` 五个键全部接线：

| 键 | 行为 |
| --- | --- |
| `open` | 弹目录选择框并扫描本地音乐（复用 `pickLocalDir`） |
| `browser` | 打开应用的音乐窗 |
| `lyric` | 开/关歌词窗（`lyric_window` 底图 + 真实歌词行） |
| `equalizer` | 开/关均衡器窗（10 段推子真实作用于音频） |
| `playlist` | 开/关播放列表窗（待播清单，点行切歌） |

### 子窗口

子窗口不是另画一套 UI，而是把皮肤包里 `lyric_window` / `playlist_window` / `equalizer_window`
的底图和按钮原样铺上，再往对应的矩形里塞应用数据：

- **歌词窗**：按歌词区高度算能放几行（Default 的 `lyric` 只有 21px 高，就是一行滚动），
  当前行高亮；`close/ontop/desklrc` 照画。
- **播放列表窗**：`playlist` 矩形里画行，行高 18px，当前曲目高亮并自动滚到中间，
  点行 `play(track, inQueue=true)`；空清单给一句提示。
- **均衡器窗**：皮肤只给了 `preamp` 一根和 `eqfactor` 一根代表图，
  10 段是按 `eqfactor` 的宽度沿窗口横向均分复制的；`enabled` 接均衡器开关，`reset` 归零。
  `balance` / `surround` 也是真的：**平衡**走 Web Audio 的 `StereoPanner`（-1..1），
  **环绕**是 M/S 交叉混（`ChannelSplitter(2)` → 4 个 Gain 交叉接回 `ChannelMerger(2)`，
  强度 k ≤ 0.35，k=0 即旁路），两者都在 `eq.ts` 的 `setBalance` / `setSurround` 里落节点。

歌词窗右上角的两个键也接上了：**置顶** → `API.SetAlwaysOnTop`（主窗口 `SetAlwaysOnTop`，
`IsAlwaysOnTop` 回读），**桌面歌词** → `API.DesktopLrc`。

### 频谱接真实 FFT

`Bars` 不再用状态驱动的假条带：播放开始时调用应用已有的 `ensureVis()`
（`eq.ts` 里 `createMediaElementSource` 建好的 `mixed/l/r` 三个 `AnalyserNode`），
每帧 `getByteFrequencyData` 后按 `bucketEdges` 的 40Hz–15kHz 对数分桶取均值，
再乘一个高频补偿（`i > n/2` 时 ×1.35），最后用「起得快、落得慢」的包络（`max(target, h*0.86)`）。
拿不到分析节点（音源没开跨源读取）才退回占位动画，并保持静默——不会因为接了 WebAudio 把声音搞没。


### 桌面歌词（独立窗口）

点歌词窗的「桌面歌词」键，Go 侧会**另建一扇窗口**，不是一个浮层：

- `qianqian/desklrc.go`：`WindowOptions{Frameless, Transparent, AlwaysOnTop, SkipTaskbar,
  DisableResize/DisableMaximize/DisableMinimize, DisableShadow}`，尺寸 620×110，`Center()` 到屏幕中间；
- 地址是同一个本地 origin + `?desklrc=1`，`web/src/main.tsx` 里按这个参数分流到 `DeskLrc.tsx`，
   只画一行大字 + 小字曲名，页面底色强制全透明（`html`/`body` 都要清，少一个就露灰底）；
- 拖动靠 CSS `--app-region: drag`（无边框窗口的标准做法），双击/右键留给页面自己处理；
- **歌词只解析一份**：主窗口算出当前行，`useEffect` 里调到 `API.DeskLrcText(line, title)`，
  Go 再 `Eval("window.__dl(line, title)")` 推进那扇窗。窗口没开时是空操作；
- 开关落 `qqjt-desklrc`，刷新后按 localStorage 恢复（窗口是 Go 建的，刷新不会自动回来）。

新增 Go 绑定：`DeskLrc(on) (bool, error)`、`DeskLrcState()`、`DeskLrcText(line, title)`、
`SetAlwaysOnTop(on) bool`。
