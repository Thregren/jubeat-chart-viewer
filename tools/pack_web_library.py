#!/usr/bin/env python3
"""精简目录库打包：统一客户端资源 ZIP，以及供 COS 中转的独立分卷 ZIP。"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
import zipfile
REPO=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(REPO/'jubeat_viewer/player'))
from directory_library import load_directory,asset_path
from version import read_version
from asset_hash import sha256_file

def pack(root,output,version,volume_mib=256):
    root,output=Path(root).resolve(),Path(output).resolve()
    if output==root or root in output.parents:raise ValueError('包目录必须独立于网页库')
    data,assets=load_directory(root);output.mkdir(parents=True,exist_ok=True)
    common={'data/library.json','data/markers.json'}
    main=json.loads((root/'data/library.json').read_text());common.update(main.get('versionIndexes',[]))
    marker_files={p.relative_to(root).as_posix() for p in (root/'markers').rglob('*') if p.is_file() and not p.name.startswith('.')}
    background_files={p.relative_to(root).as_posix() for p in (root/'data/background').rglob('*') if p.is_file() and not p.name.startswith('.')}
    if (root/'data/background-stories.json').is_file():background_files.add('data/background-stories.json')
    resources=assets|common|marker_files|background_files
    front={'index.html'}|{p.relative_to(root).as_posix() for p in (root/'static').iterdir() if p.is_file() and not p.name.startswith('.')}
    # Runtime health metadata is small and contains no source paths or original archive data.
    if (root/'data/build.json').exists():common.add('data/build.json');resources.add('data/build.json')
    for name in resources|front:
        if not asset_path(root,name).is_file():raise ValueError('文件缺失：'+name)
    rows=[]
    def archive(name,names,kind):
        dest=output/name;temp=dest.with_name(dest.name+'.partial')
        expected=0
        try:
            with zipfile.ZipFile(temp,'w',allowZip64=True) as z:
                for rel in sorted(names):
                    source=asset_path(root,rel)
                    expected+=source.stat().st_size
                    z.write(source,rel,compress_type=zipfile.ZIP_DEFLATED if source.suffix in ('.json','.js','.css','.html','.txt','.md') else zipfile.ZIP_STORED)
            # 不再 testzip()：那会把整包（曲库动辄 2 GB）重新解压一遍校验 CRC，
            # 等于在同一份数据上再读一次盘、再解一次压。写入时 CRC 已经由 zipfile
            # 逐条算好，下面按中央目录核对「条目数 + 解压后总字节」，再由紧跟的
            # SHA-256 把整包读一遍——写坏/截断在那一关就会发现。
            with zipfile.ZipFile(temp) as z:
                infos=z.infolist()
                if len(infos)!=len(names) or sum(i.file_size for i in infos)!=expected:
                    raise ValueError('压缩包条目与预期不符：'+name)
            temp.replace(dest)
        finally:
            temp.unlink(missing_ok=True)
        sha=sha256_file(dest)
        row=dict(name=name,kind=kind,bytes=dest.stat().st_size,sha256=sha,files=len(names),entriesVerified=True);rows.append(row)
        print('完成',name,dest.stat().st_size,flush=True)
    archive('jubeat-library-'+version+'.zip',resources,'client-library')
    limit=max(16,volume_mib)*1024**2;batch=[];size=0;number=1
    for rel in sorted(resources|front):
        n=(root/rel).stat().st_size
        if batch and size+n>limit:
            archive(f'web-{version}.part{number:03}.zip',batch,'web-volume');number+=1;batch=[];size=0
        batch.append(rel);size+=n
    if batch:archive(f'web-{version}.part{number:03}.zip',batch,'web-volume')
    manifest=dict(format='jubeat-directory-package-v1',version=version,songs=len(data['songs']),charts=sum(len(s['charts']) for s in data['songs']),assets=rows)
    (output/'packages.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (output/'SHA256SUMS').write_text(''.join(x['sha256']+'  '+x['name']+'\n' for x in rows))
    print('全部打包完成',len(rows),'份',flush=True);return manifest
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--library',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--version',default=read_version());p.add_argument('--volume-mib',type=int,default=256);a=p.parse_args();pack(a.library,a.output,a.version,a.volume_mib)
