jubeat Viewer 0.6.40 轻量客户端使用说明

程序与歌曲分开提供。此轻量包不包含任何歌曲、封面和原试听。

桌面版（Windows / macOS / Linux）
1. 解压程序包并启动程序。
2. 将 jubeat-library-0.6.40.zip 整个拖进程序窗口。不要拖 COS 发布分卷。
3. 程序先校验压缩包、谱面索引和全部已声明资源，再切换曲库。
4. 导入完成即可离线浏览、播放。也可在“文件→导入曲库资源包”选择 ZIP。
5. 已解压的完整曲库文件夹也可以拖入，或用文件菜单选择。程序会复制配套界面到该文件夹。

安卓版
安装 jubeat-viewer-0.6.40-android-min.apk，选择“导入资源包”，导入同一个 jubeat-library-0.6.40.zip。
安卓从系统文件选择器导入 ZIP；不需要安装 Python、解压工具或 MCZ 转换程序。

曲库内容
2459 个歌曲/谱面版本条目，7343 张谱面。音频和原试听为 Ogg Opus 80 kbps VBR，封面来自本地原始资源。
不同版本的相同可玩谱面合并保存，谱面变化单独保留。音乐魔方21首为本地提供的EXT视频复核抄谱。
无原试听时按钮隐藏；有试听时位于播放控制行最右，循环播放，再按停止。
缺少音频或封面不影响静态看谱，未确认的曲名和等级不伪造。

更新与空间
轻量程序和曲库可分别更新。导入会使用临时目录，更新曲库时需要同时容纳旧库和新库；失败会恢复旧库。
桌面导入的ZIP落在程序用户数据目录；选择文件夹则使用该文件夹。安卓优先放在Android/media/world.thregren.jubeatviewer/site。
Mac未做商业签名，首次运行可在Finder中右键“打开”。Linux AppImage可能需要先赋予执行权限。

源代码与详细说明
https://github.com/Thregren/jubeat-chart-viewer
https://github.com/Thregren/jubeat-chart-viewer/blob/master/docs/压缩曲库与客户端.md
