安装包内置插件目录。

把某个打包好的 MyGo 插件放在 qianqian/builtin/plugins/<id>/ 下（要有 plugin.json），
并在 qianqian/builtin/market.json 里登记同 id 的条目，重新编译后「插件市场」就能列出并一键安装。
