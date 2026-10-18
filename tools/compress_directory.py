#!/usr/bin/env python3
"""从本地 WAV 目录库生成供网页和轻量客户端使用的 Opus 精简库。"""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / '铺面查看器/player'))
from directory_library import load_directory, asset_path

PROFILE = 'opus/80k/vbr/audio/20ms/cl10'
FIELDS = ('id','title','titleKnown','artist','version','category','cover','resourceOnly','missing','charts')

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp=path.with_name(path.name+'.tmp')
    tmp.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
    tmp.replace(path)

def probe(path):
    p=subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_name,sample_rate,channels:format=duration','-of','json',str(path)],capture_output=True,check=True)
    return json.loads(p.stdout)

def convert(source, out, master, report, jobs=4):
    from PIL import Image, ImageOps
    source,out,master,report=map(lambda x:Path(x).resolve(),(source,out,master,report))
    if out==source or source in out.parents or out in source.parents or out==master or master in out.parents or out in master.parents:
        raise ValueError('输出必须独立于输入和母库')
    data,_=load_directory(source)
    signature=hashlib.sha256((PROFILE+str(source)+str(master)+json.dumps(data,sort_keys=True,ensure_ascii=False)).encode()).hexdigest()
    state_file=report/'转码状态.json'
    state=read(state_file) if state_file.exists() else dict(signature=signature,profile=PROFILE,done={})
    if state.get('signature')!=signature:raise ValueError('输出状态与本次源库或参数不符')
    if out.exists() and any(out.iterdir()) and not state_file.exists():raise ValueError('输出非空且没有本工具状态，拒绝覆盖')
    report.mkdir(parents=True,exist_ok=True);out.mkdir(parents=True,exist_ok=True);write(state_file,state)
    lock=threading.Lock();finished=0;original_bytes=0;compressed_bytes=0

    def song(s):
        nonlocal finished,original_bytes,compressed_bytes
        assets={};base='songs/'+s['id'];before_bytes=after_bytes=0;record={}
        for key,leaf in (('audio','bgm'),('preview','preview')):
            if key not in s['assets']:continue
            src=asset_path(source,s['assets'][key]);native=asset_path(master,s['id']+'/'+leaf+'.wav')
            if not src.samefile(native):
                with src.open('rb') as a,native.open('rb') as b:
                    if hashlib.file_digest(a,'sha256').digest()!=hashlib.file_digest(b,'sha256').digest():raise ValueError('源音频不是母库文件：'+s['id'])
            dest=out/base/(leaf+'.ogg');dest.parent.mkdir(parents=True,exist_ok=True)
            st=src.stat();fingerprint=[st.st_size,st.st_mtime_ns,st.st_ino]
            prior=state['done'].get(s['id'],{}).get(key,{})
            if prior.get('source')!=fingerprint or not dest.is_file() or dest.stat().st_size!=prior.get('bytes'):
                tmp=dest.with_name(dest.name+'.partial')
                cmd=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-i',str(src),'-map','0:a:0','-threads','1','-c:a','libopus','-b:a','80k','-vbr','on','-compression_level','10','-application','audio','-frame_duration','20','-map_metadata','-1','-f','ogg',str(tmp)]
                p=subprocess.run(cmd,capture_output=True,timeout=900)
                if p.returncode:raise RuntimeError('转码失败 '+s['id']+': '+p.stderr.decode(errors='replace')[:600])
                tmp.replace(dest)
            info=probe(dest);stream=info['streams'][0]
            if stream['codec_name']!='opus' or stream['sample_rate']!='48000':raise ValueError('编码格式不符：'+str(dest))
            record[key]=dict(source=fingerprint,bytes=dest.stat().st_size,duration=float(info['format']['duration']),codec='opus')
            assets[key]=base+'/'+dest.name;before_bytes+=st.st_size;after_bytes+=dest.stat().st_size
        if 'cover' in s['assets']:
            src=asset_path(source,s['assets']['cover']);native=asset_path(master,s['id']+'/cover.png')
            if not src.samefile(native):
                if hashlib.sha256(src.read_bytes()).digest()!=hashlib.sha256(native.read_bytes()).digest():raise ValueError('封面不是本地母库文件')
            dest=out/base/'cover.png';dest.parent.mkdir(parents=True,exist_ok=True)
            # 保留本地封面的原始像素；缩略图与原网页相同，为96px JPEG quality82。
            if not dest.exists():
                try:os.link(src,dest)
                except OSError:shutil.copyfile(src,dest)
            thumb=out/base/'thumb.jpg'
            with Image.open(src) as image:
                image=ImageOps.exif_transpose(image).convert('RGB');image.thumbnail((96,96),Image.Resampling.LANCZOS)
                image.save(thumb,'JPEG',quality=82,optimize=True)
            assets.update(cover=base+'/cover.png',thumb=base+'/thumb.jpg')
        for chart in s['charts']:
            code=chart['code'];src=asset_path(source,s['assets']['chart:'+code]);native=asset_path(master,s['id']+'/charts/'+code+'.mc')
            value=read(src)
            if value!=read(native):raise ValueError('谱面不是母库中的原谱面：'+s['id']+'/'+code)
            # 仅修正媒体文件名，不改变任何可玩音符或时序。
            value.get('meta',{})['song']='bgm.ogg'
            dest=out/base/'charts'/(code+'.json');write(dest,value);assets['chart:'+code]=base+'/charts/'+code+'.json'
        row={k:s[k] for k in FIELDS if k in s};row['assets']=assets
        with lock:
            state['done'][s['id']]=record;finished+=1;original_bytes+=before_bytes;compressed_bytes+=after_bytes
            if finished%50==0:
                write(state_file,state);print('转码完成',finished,'/',len(data['songs']),flush=True)
        return row

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,min(8,jobs))) as pool:
        songs=list(pool.map(song,data['songs']))
    write(state_file,state)
    versions=data['versions'];indexes=[]
    for version in versions:
        name='data/versions/'+version+'.json';indexes.append(name)
        write(out/name,dict(format='jubeat-directory-v1',version=1,versions=[version],songs=[s for s in songs if s['version']==version]))
    write(out/'data/library.json',dict(format='jubeat-directory-v1',version=1,versions=[],songs=[],versionIndexes=indexes))
    static=REPO/'铺面查看器/player/static'
    for p in static.iterdir():
        if p.is_file() and not p.name.startswith('.'):
            dest=out/('index.html' if p.name=='index.html' else 'static/'+p.name);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
    for top in ('markers',):
        for p in (source/top).rglob('*'):
            if p.is_file() and not p.name.startswith('.'):
                dest=out/p.relative_to(source);dest.parent.mkdir(parents=True,exist_ok=True)
                if not dest.exists():
                    try:os.link(p,dest)
                    except OSError:shutil.copyfile(p,dest)
    shutil.copyfile(source/'data/markers.json',out/'data/markers.json')
    from build_share_pages import build_share_pages
    build_share_pages(out, out, version=(REPO/'VERSION').read_text().strip(), songs=songs)
    summary=dict(status='complete',format='jubeat-directory-v1',profile=PROFILE,songs=len(songs),charts=sum(len(s['charts']) for s in songs),audio=sum('audio' in s['assets'] for s in songs),previews=sum('preview' in s['assets'] for s in songs),covers=sum('cover' in s['assets'] for s in songs),sourceAudioBytes=original_bytes,compressedAudioBytes=compressed_bytes,mczOpened=0,legacyMetadataRead=False,webMediaImported=False,originalsAndExactEventsIncluded=False)
    write(out/'data/build.json',summary);write(report/'转码结果.json',summary)
    print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)
    return summary

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--library',required=True,type=Path);p.add_argument('--master',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--report',required=True,type=Path);p.add_argument('--jobs',type=int,default=4);a=p.parse_args()
    convert(a.library,a.out,a.master,a.report,a.jobs)
