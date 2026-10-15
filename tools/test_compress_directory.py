import json
from pathlib import Path
import tempfile
import unittest
import wave
import os
import shutil
from PIL import Image
from compress_directory import convert,read,write,probe

class CompressTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'需要ffmpeg与ffprobe')
    def test_native_media_to_opus_and_only_playback_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=Path(tmp);source=r/'source';master=r/'master';out=r/'out';report=r/'report';id='v/首次收录/id'
            native=master/id;native.mkdir(parents=True)
            with wave.open(str(native/'bgm.wav'),'wb') as f:f.setnchannels(2);f.setsampwidth(2);f.setframerate(48000);f.writeframes(b'\0'*48000*4)
            Image.new('RGBA',(300,300),(240,40,100,255)).save(native/'cover.png')
            chart={'meta':{'mode':4,'song':'bgm.wav'},'note':[{'beat':[0,0,1],'index':0},{'beat':[1,0,1],'index':4}]};write(native/'charts/EXT.mc',chart)
            base='songs/'+id;folder=source/base;folder.mkdir(parents=True)
            for name in ('bgm.wav','cover.png'):os.link(native/name,folder/name)
            write(folder/'charts/EXT.json',chart)
            song=dict(id=id,title='测试',version='v',cover='cover.png',charts=[{'code':'EXT','notes':2,'holds':0}],metadataEvidence={'large':'not-runtime'},assets={'audio':base+'/bgm.wav','cover':base+'/cover.png','chart:EXT':base+'/charts/EXT.json'},missing=['preview'])
            write(source/'data/library.json',dict(format='jubeat-directory-v1',songs=[song],versions=['v'],versionIndexes=[]));write(source/'data/markers.json',{});(source/'markers').mkdir()
            result=convert(source,out,master,report,1);self.assertEqual(result['songs'],1)
            exported=read(out/'data/versions/v.json')['songs'][0]
            self.assertNotIn('metadataEvidence',exported);self.assertNotIn('preview',exported['assets'])
            self.assertEqual(exported['cover'],'cover.png')
            self.assertEqual(probe(out/exported['assets']['audio'])['streams'][0]['codec_name'],'opus')
            self.assertEqual(read(out/exported['assets']['chart:EXT'])['note'],chart['note'])
            with Image.open(out/exported['assets']['thumb']) as thumb:self.assertEqual(thumb.size,(96,96))
            self.assertEqual(list(out.rglob('*.wav')),[]);self.assertTrue((native/'bgm.wav').exists())

if __name__=='__main__':unittest.main()
