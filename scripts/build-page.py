#!/usr/bin/env python3
# 把 web/ 的前端构建产物拼成 qianqian/page.html。
#
# 为什么要拼：vite 构建出来是一个 dist/index.html（js/css 已内联），
# 但独立版还需要在 <head> 里保留一段 mygo 桥接 shim —— 页面在 WebView 里
# 先有 window.go 才能调用 Go 方法。所以：dist 的 HTML 前段 + 老 page.html 里的
# 第一个 <script>…</script>（就是那段 shim）+ dist 剩下的部分。
#
# 用法：python3 scripts/build-page.py
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
dist = root / "web" / "dist" / "index.html"
page = root / "qianqian" / "page.html"

if not dist.exists():
    sys.exit("找不到 web/dist/index.html，先在 web/ 里跑：npx vite build")

html = dist.read_text(encoding="utf-8")
if not page.exists():
    sys.exit("找不到 qianqian/page.html，无法取 shim")

old = page.read_text(encoding="utf-8")
m = re.search(r"<script[^>]*>.*?</script>", old, re.S)
if not m:
    sys.exit("老 page.html 里找不到 shim <script>")

i = html.index(">") + 1
out = html[:i] + m.group(0) + html[i:]
page.write_text(out, encoding="utf-8")
print(f"page.html 已更新：{len(out)} 字符")
