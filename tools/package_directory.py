#!/usr/bin/env python3
"""为开放目录曲库生成公共浏览器包（不包含歌曲，配合按版本ZIP安装）。"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile
from build_directory import build_directory, REPO

GUIDE = '''本地统一曲库网页版（jubeat-directory-v1）

1. 建立一个空目录，先把 00_浏览器公共文件.zip 解压到这里。
2. 把同一批导出的任意版本ZIP也解压到同一目录。保留 data/ 和 songs/ 的层级，
   不要给每个包再套一层版本目录。无需下载或扫描任何旧MCZ曲库。
3. 在这个目录执行：python3 启动查看器.py
4. 用浏览器打开 http://127.0.0.1:8124/ 。修改端口：python3 启动查看器.py --port 8125
   要求 Python 3.10+，无需 ffmpeg。不要直接双击 index.html（file:// 不支持 fetch）。
5. 搜索或按版本筛选，选择歌曲和难度。播放原试听使用独立 preview.wav；
   完整播放使用 bgm.wav。缺少资源会明确标注，不借用其他曲库，不从正曲裁切试听。

谱面：charts/BSC.json 等为兼容现有播放器的开放JSON（MC数据结构，没有MCZ容器）。
精确事件另存 *.events.json，保留源tick_hz；原游戏一般300Hz，音乐魔方视频抄谱另有时间分辨率；兼容JSON的拍点使用既有换算，
不宣称已消除该换算的时间量化。原EVE/SEQ和provenance.json随歌曲保留。
PCM24 WAV保留统一库采样率和声道；封面PNG沿用已修正颜色的统一库。
本批已移除209个特殊资源条目，版本包不再包含这些文件。等级/曲名未知时显示未知或原ID。

去重延续统一库：最早街机版本优先，移动版补充；有可玩音符/时序变化才另存。
版本名表示本次源文件的归档归属，不据此推断实际初次上线日期。
零新增版本的包只有来源索引；来源索引可以追溯被更早版本收录的歌曲。
单包不是原版完整曲库，不能用包内首数当作该游戏版本的完整歌曲数量。

校验：各版本ZIP中的 PACKAGE.json 给出成员SHA-256；外部 .zip.json记录整包SHA-256、
大小与CRC结果。打包校验.json汇总各版本。00_浏览器公共文件.zip.json校验公共包。
只安装部分版本时，未安装版本索引的404会被跳过；已安装版本的损坏索引会报错。
新一批包需同时更新公共包和所选版本包，建议使用新空目录，避免混合旧清单。

详细说明：https://github.com/Thregren/jubeat-chart-viewer/blob/master/docs/目录曲库.md
导出工具：https://github.com/Thregren/jubeat-extract-tools
'''
LAUNCHER = '''#!/usr/bin/env python3
from pathlib import Path
import sys
root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / 'tools'))
from serve import main
if __name__ == '__main__':
    sys.argv.insert(1, str(root))
    raise SystemExit(main())
'''


def package_common(root: Path, output: Path, rebuild=True):
    root, output = root.resolve(), output.resolve()
    if rebuild: build_directory(root, root)
    if not (root/'data/build.json').is_file(): raise ValueError('请先构建目录站点')
    for name in ('tools/serve.py','铺面查看器/player/media.py','铺面查看器/player/source_revision.py'):
        dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(REPO/name,dest)
    (root/'启动查看器.py').write_text(LAUNCHER,encoding='utf-8')
    (root/'使用说明.txt').write_text(GUIDE,encoding='utf-8')
    names={'index.html','data/library.json','data/markers.json','data/build.json','data/export.json',
           'tools/serve.py','铺面查看器/player/media.py','铺面查看器/player/source_revision.py',
           '启动查看器.py','使用说明.txt'}
    for top in ('static','markers','share'):
        names.update(p.relative_to(root).as_posix() for p in (root/top).rglob('*') if p.is_file() and not any(x.startswith('.') for x in p.relative_to(root).parts))
    output.parent.mkdir(parents=True,exist_ok=True);temp=output.with_name(output.name+'.partial')
    with zipfile.ZipFile(temp,'w',compression=zipfile.ZIP_DEFLATED,allowZip64=True) as z:
        for name in sorted(names): z.write(root/name,name)
    with zipfile.ZipFile(temp) as z:
        if z.testzip(): raise ValueError('公共包CRC校验失败')
    temp.replace(output)
    with output.open('rb') as stream:
        sha=hashlib.file_digest(stream,'sha256').hexdigest() if hasattr(hashlib,'file_digest') else hashlib.sha256(stream.read()).hexdigest()
    report=dict(format='jubeat-directory-v1',package='common',files=len(names),bytes=output.stat().st_size,sha256=sha,crc_verified=True)
    output.with_suffix('.zip.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--library',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();package_common(a.library,a.output)
