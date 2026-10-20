"""Build a self-contained browser fixture; never read the real library."""
import argparse,json,os,subprocess,sys,wave
from pathlib import Path
from PIL import Image,ImageDraw
REPO=Path(__file__).resolve().parents[1]

def build(root):
    library=root/'library';markers=root/'markers';out=root/'site'
    shared=library/'songs/shared';shared.mkdir(parents=True,exist_ok=True)
    with wave.open(str(shared/'bgm.wav'),'wb') as file:
        file.setnchannels(1);file.setsampwidth(2);file.setframerate(16000);file.writeframes(b'\0'*16000*2*60)
    (shared/'alternate.wav').write_bytes((shared/'bgm.wav').read_bytes())
    image=Image.new('RGB',(96,96),(42,84,126));image.save(shared/'cover.png');image.save(shared/'thumb.jpg')
    for code,count in [('BSC',128),('EXT',256)]:
        notes=[dict(beat=[i//4,i%4,4],index=i%16) for i in range(count)]
        notes[16].update(endbeat=[8,0,1],endindex=0)
        chart=dict(meta={'song':{'title':'Browser fixture','artist':'Synthetic'}},time=[{'beat':[0,0,1],'bpm':120}],note=notes)
        (shared/(code+'.json')).write_text(json.dumps(chart))
    indexes=[]
    for version in range(8):
        songs=[]
        for index in range(40):
            songs.append(dict(id=f'v{version}/song{index:03}',title=f'Song {version}-{index:03}',artist='Browser fixture',version=f'v{version}',cover='cover.png',
              charts=[dict(code='BSC',level='4',notes=128,holds=1),dict(code='EXT',level='10',notes=256,holds=1)],
              assets={'audio':'songs/shared/'+('bgm.wav' if index%2 else 'alternate.wav'),'cover':'songs/shared/cover.png','thumb':'songs/shared/thumb.jpg',
                      'chart:BSC':'songs/shared/BSC.json','chart:EXT':'songs/shared/EXT.json'}))
        relative=f'data/versions/v{version}.json';path=library/relative;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(dict(format='jubeat-directory-v1',songs=songs,versions=[f'v{version}'])));indexes.append(relative)
    (library/'data/library.json').write_text(json.dumps(dict(format='jubeat-directory-v1',songs=[],versions=[],versionIndexes=indexes)))
    directory=markers/'tex_l44_tm0004';directory.mkdir(parents=True,exist_ok=True)
    for channel,count in [('MA',24),('H4',16)]:
        for index in range(count):
            image=Image.new('RGBA',(160,160));draw=ImageDraw.Draw(image)
            alpha=255 if channel=='MA' else round(255*(15-index)/15)
            draw.ellipse((index, index, 159-index,159-index),fill=(240,110,30,alpha));image.save(directory/f'TM0004_{channel}{index:02}.png')
    (markers/'manifest.json').write_text(json.dumps(dict(designs=[dict(id='tm0004',num=4,dir=directory.name,prefix='TM0004',ma=24,h={'4':16},fr=0,name='Synthetic')],unit_ms=3.3333,units_per_frame=10,hit_window_units={'early':-155,'late':160})))
    env=os.environ|{'JUBEAT_MARKERS':str(markers),'JUBEAT_CACHE':str(root/'cache')}
    subprocess.run([sys.executable,str(REPO/'tools/build_directory.py'),'--library',str(library),'--out',str(out)],env=env,check=True)
    return out

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args();build(args.out.resolve())
