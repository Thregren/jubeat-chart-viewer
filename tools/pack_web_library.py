#!/usr/bin/env python3
"""精简目录库打包：统一客户端资源 ZIP，以及供 COS 中转的独立分卷 ZIP。"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import zipfile
REPO=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(REPO/'jubeat_viewer/player'))
from directory_library import load_directory,asset_path
from version import read_version
from asset_hash import sha256_file
from package_backgrounds import background_files
from package_publication import PackagePublication, legacy_web_names, plain_name, publication_lock

def pack(root,output,version,volume_mib=256,verify_crc=False):
    root=Path(root).resolve()
    output=Path(os.path.abspath(output))
    resolved_output=output.resolve()
    if resolved_output==root or root in resolved_output.parents:raise ValueError('包目录必须独立于网页库')
    plain_name(version)
    output.mkdir(parents=True,exist_ok=True)
    with publication_lock(output.parent, output.name):
        publication = PackagePublication(output, 'web-packages')
        legacy = legacy_web_names(output)
        generation = publication.new_generation()
        try:
            manifest = _pack(root,generation,version,volume_mib,verify_crc)
            names = ['packages.json','SHA256SUMS'] + [row['name'] for row in manifest['assets']]
            publication.publish(generation,names,legacy)
            return manifest
        except BaseException:
            if not publication.current.is_symlink() or publication.current.resolve() != generation:
                shutil.rmtree(generation,ignore_errors=True)
            raise

def _pack(root,output,version,volume_mib,verify_crc):
    data,assets=load_directory(root)
    common={'data/library.json','data/markers.json'}
    main=json.loads((root/'data/library.json').read_text());common.update(main.get('versionIndexes',[]))
    marker_files={p.relative_to(root).as_posix() for p in (root/'markers').rglob('*') if p.is_file() and not p.name.startswith('.')}
    resources=assets|common|marker_files|background_files(root)
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
            # 中央目录检查只验证记录，发行校验还须读取成员并验证 CRC。
            with zipfile.ZipFile(temp) as z:
                infos=z.infolist()
                if len(infos)!=len(names) or sum(i.file_size for i in infos)!=expected:
                    raise ValueError('压缩包条目与预期不符：'+name)
                if verify_crc:
                    bad=z.testzip()
                    if bad is not None:raise ValueError('压缩包 CRC 校验失败：'+bad)
            temp.replace(dest)
        finally:
            temp.unlink(missing_ok=True)
        sha=sha256_file(dest)
        row=dict(name=name,kind=kind,bytes=dest.stat().st_size,sha256=sha,files=len(names),entriesVerified=True,crcVerified=verify_crc);rows.append(row)
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
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--library',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--version',default=read_version());p.add_argument('--volume-mib',type=int,default=256);p.add_argument('--verify-crc',action='store_true',help='读取全部成员并校验 CRC（用于正式发行）');a=p.parse_args();pack(a.library,a.output,a.version,a.volume_mib,a.verify_crc)
