"""Immutable parts, portable version ZIP compatibility and exact atlas pixels."""
import io,json,sys,tempfile,unittest,wave
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'铺面查看器/player'))
from PIL import Image,ImageChops
import web_assets as W
from directory_library import load_directory
from package_site import portable_files
from markers import _normalize

class WebAssets(unittest.TestCase):
    def test_independent_marker_timing_survives_backend_normalization(self):
        timing={'approach_ms':516.6615,'ma_hit_frame':30,'burst_ms':533.328}
        design=dict(id='tm1001',num=1001,dir='tex_l44_tm1001',prefix='TM1001',ma=94,h={'4':100},timing=timing)
        self.assertEqual(_normalize(dict(designs=[design]))['designs'][0]['timing'],timing)
        for invalid in [dict(timing,ma_hit_frame=94),dict(timing,burst_ms=float('nan')),dict(timing,approach_ms=True)]:
            self.assertEqual(_normalize(dict(designs=[dict(design,timing=invalid)]))['designs'],[])

    def test_without_pillow_legacy_frames_still_build(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(sys.modules,{'PIL':None}):
            root=Path(temp);manifest={'designs':[]}
            self.assertEqual(W.optimize_markers(root,manifest),[])
            self.assertEqual(json.loads((root/'data/markers.json').read_bytes()),manifest)

    def test_index_aliases_keep_old_generation_and_portable_references(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'data/versions').mkdir(parents=True);(root/'songs/v').mkdir(parents=True)
            media=root/'songs/v/bgm.wav'
            with wave.open(str(media),'wb') as file:file.setnchannels(2);file.setsampwidth(2);file.setframerate(48000);file.writeframes(b'\0'*48000*4)
            song=dict(id='v/id',title='Song',version='v',charts=[],resourceOnly=True,assets={'audio':'songs/v/bgm.wav'})
            part=root/'data/versions/v.json';part.write_bytes(W.encode(dict(format='jubeat-directory-v1',songs=[song])))
            manifest=root/'data/library.json';manifest.write_bytes(W.encode(dict(format='jubeat-directory-v1',songs=[],versionIndexes=['data/versions/v.json','data/versions/missing.json'])))
            first=W.publish_catalog(root)[0];self.assertNotEqual(first,'data/versions/v.json');self.assertTrue((root/first).is_file())
            data,_=load_directory(root);self.assertEqual(data['songs'][0]['audioInfo']['duration'],1)
            files,replacements=portable_files(root);portable=json.loads(replacements['data/library.json'])
            self.assertEqual(portable['versionIndexes'],['data/versions/v.json','data/versions/missing.json']);self.assertNotIn(first,files)
            value=json.loads((root/first).read_bytes());value['songs'][0]['title']='Updated';(root/first).write_bytes(W.encode(value))
            second=W.publish_catalog(root)[0];self.assertNotEqual(first,second);self.assertTrue((root/first).is_file())

    def test_atlas_preserves_rgba_alpha_and_edge_clamping(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);directory=root/'markers/tex_l44_tm0001';directory.mkdir(parents=True)
            design=dict(id='tm0001',dir=directory.name,prefix='TM0001',ma=2,h={'4':1})
            images={}
            for name,alpha in [('MA00',0),('MA01',101),('H400',255)]:
                image=Image.new('RGBA',(8,8),(20,90,170,alpha));image.putpixel((0,0),(230,10,40,alpha))
                image.save(directory/f'TM0001_{name}.png');images[name]=image
            paths=W.optimize_markers(root,dict(designs=[design]));self.assertEqual(len(paths),2)
            data=json.loads((root/'data/markers.json').read_bytes())
            for channel,atlas in data['designs'][0]['atlases'].items():
                with Image.open(root/'markers'/atlas['file']) as image:
                    for i,(x,y,w,h,alpha) in enumerate(atlas['rects']):
                        source=images[channel+f'{i:02d}'];self.assertEqual(image.crop((x,y,x+w,y+h)).tobytes(),source.tobytes())
                        self.assertEqual(image.getpixel((x-1,y)),source.getpixel((0,0)));self.assertEqual(alpha,source.getchannel('A').getextrema()[1]/255)
            retained,_=portable_files(root) if (root/'data/library.json').exists() else (None,None)
            self.assertEqual(W.optimize_markers(root,dict(designs=[design])),paths)

if __name__=='__main__':unittest.main()
