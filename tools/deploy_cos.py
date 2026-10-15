#!/usr/bin/env python3
"""通过既有 tccli 凭证，将精简站点独立分卷经 COS/TAT 发布。显式指定所有目标。"""
from __future__ import annotations
import argparse,base64,hashlib,json,os,shlex,subprocess,time
from pathlib import Path

def cli(args):
    p=subprocess.run(['tccli']+args,capture_output=True,text=True)
    if p.returncode:raise RuntimeError('tccli操作失败：'+args[0]+'/'+args[1]+'，退出码'+str(p.returncode))
    return p.stdout

def cos(region):
    from qcloud_cos import CosConfig,CosS3Client
    a=json.loads((Path.home()/'.tccli/default.credential').read_text())
    return CosS3Client(CosConfig(Region=region,SecretId=a['secretId'],SecretKey=a['secretKey'],Token=a.get('token'),Scheme='https'))

def signed_url(region,bucket,key):
    a=json.loads((Path.home()/'.tccli/default.credential').read_text())
    params={'x-cos-security-token':a['token']} if a.get('token') else {}
    return cos(region).get_presigned_url(Method='GET',Bucket=bucket,Key=key,Expired=3600,Params=params)

def tat(instance,region,script,timeout=600,hidden=None):
    args=['tat','RunCommand','--region',region,'--InstanceIds',json.dumps([instance]),'--CommandType','SHELL','--Content',base64.b64encode(script.encode()).decode(),'--Timeout',str(timeout)]
    if hidden:args+=['--EnableParameter','true','--Parameters',json.dumps(hidden)]
    result=json.loads(cli(args));result=result.get('Response',result);inv=result['InvocationId']
    deadline=time.monotonic()+timeout+90
    while time.monotonic()<deadline:
        time.sleep(3)
        a=json.loads(cli(['tat','DescribeInvocationTasks','--region',region,'--Filters',json.dumps([{'Name':'invocation-id','Values':[inv]}])]))
        a=a.get('Response',a)
        for row in a.get('InvocationTaskSet',[]):
            status=row.get('TaskStatus')
            if status in ('PENDING','RUNNING','DELIVERING','STARTING'):continue
            output=base64.b64decode(row.get('TaskResult',{}).get('Output','')).decode(errors='replace')
            if status!='SUCCESS' or row.get('TaskResult',{}).get('ExitCode')!=0:
                # Do not echo remote output: a network exception can contain a signed URL.
                raise RuntimeError('TAT远程操作失败：'+str(status)+' '+inv)
            return output
    raise TimeoutError('TAT超时 '+inv)

def python_script(text):return "set -e\npython3 - <<'PY'\n"+text+"\nPY\n"

def deploy(a):
    root=Path(a.packages).resolve();manifest=json.loads((root/'packages.json').read_text());version=manifest['version']
    volumes=[x for x in manifest['assets'] if x['kind']=='web-volume']
    fingerprint=hashlib.sha256((root/'packages.json').read_bytes()).hexdigest()
    report=Path(a.report).resolve();report.mkdir(parents=True,exist_ok=True);state_file=report/'COS部署状态.json'
    signature=[a.bucket,a.region,a.instance,a.instance_region,a.target,a.prefix,fingerprint]
    state=json.loads(state_file.read_text()) if state_file.exists() else dict(signature=signature,uploaded={},staged={})
    if state['signature']!=signature:raise ValueError('发布状态与目标或包清单不一致')
    def save():state_file.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
    target=Path(a.target)
    if not target.is_absolute() or len(target.parts)<4 or target.name in ('wwwroot','www','root'):raise ValueError('目标必须是明确的站点根目录')
    stage=str(target.parent/('.'+target.name+'-unified-'+version));remote_state=stage+'.state.json'
    if a.mode in ('all','stage','activate'):
        print(tat(a.instance,a.instance_region,python_script(f'''
import json,pathlib
stage=pathlib.Path({stage!r});state=pathlib.Path({remote_state!r})
if state.exists():
 assert json.loads(state.read_text())['fingerprint']=={fingerprint!r},'remote stage belongs to another package'
elif stage.exists():raise RuntimeError('refusing unowned staging directory')
else:
 stage.mkdir();state.write_text(json.dumps(dict(fingerprint={fingerprint!r})))
print('staging ready')
''')).strip(),flush=True)
    for row in volumes:
        name=row['name'];file=root/name
        if file.stat().st_size!=row['bytes']:raise ValueError('本地分卷大小变更：'+name)
        key=a.prefix.rstrip('/')+'/'+name
        if a.mode in ('all','upload'):
            if state['uploaded'].get(name)!=row['sha256']:
                cli(['cos','upload','--region',a.region,'--bucket',a.bucket,'--local_path',str(file),'--cos_key',key,'--meta','sha256='+row['sha256'],'--thread_num','4','--part_size','8','--retry','3'])
            head=cos(a.region).head_object(Bucket=a.bucket,Key=key)
            if int(head['Content-Length'])!=row['bytes'] or head.get('x-cos-meta-sha256')!=row['sha256']:raise RuntimeError('COS分卷校验不符：'+name)
            state['uploaded'][name]=row['sha256'];save();print('COS已校验',name,row['bytes'],flush=True)
        if a.mode in ('all','stage') and state['staged'].get(name)!=row['sha256']:
            url=signed_url(a.region,a.bucket,key)
            text=f'''
import pathlib,urllib.request,hashlib,zipfile,stat
root=pathlib.Path({stage!r});tmp=root/'.transfer.zip';url="{{{{tat-hidden:volume_url}}}}"
with urllib.request.urlopen(url,timeout=120) as src,tmp.open('wb') as dst:
 while True:
  block=src.read(1024*1024)
  if not block:break
  dst.write(block)
h=hashlib.sha256()
with tmp.open('rb') as src:
 for block in iter(lambda:src.read(1024*1024),b''):h.update(block)
assert h.hexdigest()=={row['sha256']!r},'volume checksum mismatch'
with zipfile.ZipFile(tmp) as z:
 for info in z.infolist():
  name=info.filename;p=pathlib.PurePosixPath(name)
  assert not p.is_absolute() and not any(x in ('','..','.') for x in name.split('/')) and chr(92) not in name
  assert not stat.S_ISLNK(info.external_attr>>16)
  assert p.parts[0] in ('data','songs','markers','static','index.html')
  dest=root.joinpath(*p.parts);dest.parent.mkdir(parents=True,exist_ok=True)
  with z.open(info) as src,dest.open('wb') as dst:
   while True:
    block=src.read(1024*1024)
    if not block:break
    dst.write(block)
tmp.unlink();print('volume staged')
'''
            tat(a.instance,a.instance_region,python_script(text),hidden={'volume_url':url})
            state['staged'][name]=row['sha256'];save();print('服务器已校验解压',name,flush=True)
    if a.mode not in ('all','activate'):return state
    validation=f'''
import pathlib,json
root=pathlib.Path({stage!r});main=json.loads((root/'data/library.json').read_text());assert main['format']=='jubeat-directory-v1'
songs=list(main['songs'])
for name in main['versionIndexes']:songs.extend(json.loads((root/name).read_text())['songs'])
assert len(songs)=={manifest['songs']};assert sum(len(s['charts']) for s in songs)=={manifest['charts']}
for song in songs:
 for key,name in song['assets'].items():
  p=(root/name).resolve();assert root.resolve() in p.parents and p.is_file()
  if key in ('audio','preview'):
   with p.open('rb') as f:assert b'OpusHead' in f.read(128)
assert not list(root.rglob('*.wav')) and not list(root.rglob('*.mcz')) and not list(root.rglob('*.mc'))
assert 'Swan416ya' not in (root/'index.html').read_text()
print('validated',{manifest['songs']},{manifest['charts']})
'''
    state['validation']=tat(a.instance,a.instance_region,python_script(validation)).strip();save();print(state['validation'],flush=True)
    if not a.activate:print('暂存验证完成；显式加 --activate 才切换并删除旧站点',flush=True);return state
    # All content work is done before the explicitly requested replacement.
    activation=f'''
import pathlib,os,shutil,subprocess,json
target=pathlib.Path({str(target)!r});stage=pathlib.Path({stage!r});old=target.with_name('.'+target.name+'-retired-'+{version!r})
conf=pathlib.Path('/www/server/panel/vhost/nginx/'+target.name+'.conf');backup=conf.with_name(conf.name+'.before-unified-'+{version!r})
assert not old.exists() and not target.is_symlink()
original=conf.read_text();backup.write_text(original)
if 'location /songs/' not in original:
 pos=original.find('    location /media/ {{');end=original.find(chr(10)+'    }}',pos)
 assert pos>=0 and end>pos
 block=original[pos:end+6].replace('location /media/','location /songs/',1)+chr(10)*2
 conf.write_text(original[:pos]+block+original[pos:])
try:
 subprocess.run(['/www/server/nginx/sbin/nginx','-t'],check=True,capture_output=True)
 if (target/'.well-known').exists():shutil.copytree(target/'.well-known',stage/'.well-known',dirs_exist_ok=True)
 subprocess.run(['chown','-R','www:www',str(stage)],check=True)
 target.rename(old);stage.rename(target)
 subprocess.run(['/www/server/nginx/sbin/nginx','-s','reload'],check=True,capture_output=True)
 data=subprocess.check_output(['curl','-fsS','--resolve',target.name+':443:127.0.0.1','https://'+target.name+'/data/library.json'])
 assert json.loads(data)['format']=='jubeat-directory-v1'
except BaseException:
 conf.write_text(original)
 if old.exists():
  if target.exists():target.rename(stage)
  old.rename(target)
 subprocess.run(['/www/server/nginx/sbin/nginx','-s','reload'],capture_output=True)
 raise
shutil.rmtree(old)
print('activated; old website resources removed')
'''
    state['activation']=tat(a.instance,a.instance_region,python_script(activation),timeout=900).strip();state['status']='complete';save();print(state['activation'],flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('packages','report','bucket','region','instance','instance-region','target','prefix'):p.add_argument('--'+name,required=True)
    p.add_argument('--mode',choices=('all','upload','stage','activate'),default='all');p.add_argument('--activate',action='store_true');deploy(p.parse_args())
