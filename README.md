# Pengu Blacklist

**Pengu Blacklist 1.0** 是国服《英雄联盟》客户端的黑名单插件，基于 Pengu Loader 运行。遇到摆烂、喷子或不想再排到的队友时，可以提前记录并获得提醒。

在 GitHub Releases 页面下载 `pengu-blacklist-v1.0.0.zip` 并解压，然后选择以下任一方式安装。

## 自动安装（推荐）

1. 双击运行 **`安装黑名单.cmd`**，脚本会自动搜索本地的 Pengu Loader 并完成安装。
2. **如果未安装 Pengu Loader**：脚本会自动引导安装，直接点击安装，或手动选择一个**游戏目录之外**的文件夹即可。
3. **首次启用**：安装好 Pengu Loader 后，在完成提示中点击「是」打开主界面，并开启**启用开关（Enable）**。（参考：[Pengu Loader 安装文档](https://pengu.lol/guide/installation)）
4. 启动《英雄联盟》客户端（若客户端已打开，重启一次即可生效）。

> **提示**：首次自动下载 Pengu Loader 需要连接 GitHub。如果下载失败，请使用下方的手动安装方式。

## 手动安装

1. **安装 Pengu Loader**：下载官方便携版 ZIP，解压到**游戏目录之外**的固定位置。打开 `Pengu Loader.exe`，确认已开启**启用开关**。（下载：[Pengu Loader 1.1.6](https://github.com/PenguLoader/PenguLoader/releases/tag/v1.1.6)）
2. **创建插件目录**：打开 `Pengu Loader.exe` 所在目录，找到（或新建）`plugins` 文件夹，再在其中新建 `blacklist` 文件夹。（参考：[Pengu Loader 插件目录说明](https://pengu.lol/guide/javascript-plugin#plugin-layouts)）
3. **复制插件文件**：将解压出的 `index.js`、`styles.css`、`config.json` 和整个 `lib` 文件夹放入 `blacklist` 目录中。
   - **路径示例**：若 Pengu Loader 位于 `C:\Games\Pengu Loader`，则 `index.js` 的完整路径应为 `C:\Games\Pengu Loader\plugins\blacklist\index.js`。
4. **重启生效**：启动或重启《英雄联盟》客户端。

## 使用说明

进入客户端后，点击界面上的**「黑名单」**入口，或使用快捷键 **`Alt + B`** 打开管理面板。

- **快捷拉黑**：在战绩详情页或对局结算页点击「拉黑」。
- **手动添加**：在黑名单管理页中，输入完整的 **Riot ID**（如 `玩家名#12345`）手动添加。

## 数据保存

- **本地存储**：所有黑名单记录及设置均保存在本机，默认提醒**仅自己可见**。
- **备份与迁移**：重装系统或更换电脑前，可在「黑名单管理」中将名单导出为 JSON 文件，之后再通过导入功能恢复。
