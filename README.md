# 葫芦音乐 · 独立版

葫芦音乐 · 桌面版：只保留桌面界面（左侧竖排导航 + 右侧内容 + 底部播放条 + 迷你浮卡），
不含皮肤窗口 / 换肤界面，也不内置网络电台与播客听书。

不再依赖 mygo-music：没有它的原生主窗口、原生菜单、原生插件页和音乐库。
只留两样东西 —— `github.com/egoist/mygo`（窗口与 WebView 框架）和 `qianqian`
（自包含的播放器后端）。

## 结构

```
main.go              窗口 + 单实例锁 + 拖放装插件 + 启动日志
qianqian/            后端：本地 http 服务、page.html、插件安装、本地音乐
web/                 界面源码（React + Vite），构建产物压成 qianqian/page.html
scripts/build-page.py  把 web 构建产物拼回 page.html 的脚本
rsrc_windows_amd64.syso   Windows 图标与版本资源
appicon.ico           图标源文件
```

`qianqian` 包只 import 标准库和 `github.com/egoist/mygo`，不引任何 mygo-music 的包，
所以整个模块可以单独拿走、单独升级。

## 构建

```bash
# Windows（无控制台）
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui" -o hulu-music.exe .

# Linux
go build -o hulu-music .
```

依赖只有 `github.com/egoist/mygo v0.9.0` 和三个间接依赖（purego、x/net、x/text）。

## 和「加装版」的区别

| | 独立版（本项目） | 加装版（mygo-music fork） |
|---|---|---|
| 依赖 | 只有 mygo 框架 | mygo-music 整个应用 |
| 产物 | ~19.9 MB | ~43.4 MB |
| 皮肤界面 | 无 | 有（另开一个 WebView 窗口） |
| 迷你浮卡 | 有（同窗口缩放至 348×124） | 有 |
| 原生主界面 / 原生菜单 | 无 | 有 |
| 插件 | 自己的安装器（zip / 文件夹 / 拖放） | 原生插件页 + 自己的安装器 |
| 插件接口 | MyGo 规范子集（search / stream / lyrics） | MyGo 完整接口 |

## 运行期数据

独立版有自己的目录，和加装版互不干扰：

```
~/.hulu-music/                  # Windows: C:\Users\<你>\.hulu-music
├── plugins/                    # 已装插件（一个插件一个子目录）
├── plugin-data/                # 插件自己的数据
├── settings.json               # 主题、音量、音源等
├── plugins.json                # 插件启用状态
├── library.json                # 本地乐库
└── qqjt-boot.log               # 启动日志，出问题先看这个
```

第一次启动时，如果 `~/.hulu-music` 还是空的，程序会把加装版
`~/.hulu-music-desktop` 里的插件和设置**复制**一份过来（旧目录原样保留，
两边之后各管各的）。

想换位置就设环境变量 `HULU_DATA_DIR`。

## 页面（界面源码就在本仓库）

`qianqian/page.html` 是前端构建产物（单文件，内联 CSS/JS），由 `go:embed` 打进二进制。
源码在 `web/`（同一套 React 界面），改完界面这样重建：

```bash
cd web
npm ci
npx tsc --noEmit
npx vite build
cd ..
python3 scripts/build-page.py     # 把 web/dist/index.html 拼回 qianqian/page.html（保留 mygo shim）
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui" -o hulu-music.exe .
```

`scripts/build-page.py` 做的事：取 `web/dist/index.html`，在 `<head>` 后面插入
老 `qianqian/page.html` 里的第一个 `<script>…</script>`（那是调用 Go 方法的 mygo
桥接 shim），其余部分原样拼上。不跑这一步直接编，窗口里点按钮会没反应。
