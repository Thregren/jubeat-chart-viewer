"""Regression tests for per-member builds, strict covers and safe hash retention."""
import io,json,os,sys,tempfile,time,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
import site_builder as b
import site_gc as gc
from PIL import Image

class Assets(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.out=self.root/'site';self.out.mkdir();self.mcz=self.root/'song.mcz'
        im=Image.new('RGB',(256,256),(100,80,50));buf=io.BytesIO();im.save(buf,'PNG');self.cover=buf.getvalue()
        self.song={'id':'song.mcz','title':'Song','artist':'Artist','audio':'audio.ogg','cover':'jkt.png',
                   'charts':[{'code':'EXT','file':'EXT.mc','level':'8'}]}
        self.patches=[patch.object(b.config,'LIBRARY',self.root),patch.object(b.audio_opus,'profile',return_value='test'),
                      patch.object(b.audio_opus,'encode',side_effect=lambda data,cache:(data,'cached')),
                      patch.object(b.config,'THUMB_SIZE',96)]
        for p in self.patches:p.start()
        self.package()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    def package(self,artist='Artist',cover=None):
        self.song['artist']=artist
        with zipfile.ZipFile(self.mcz,'w') as z:
            z.writestr('audio.ogg',b'OggSfixtureaudio'*100)
            z.writestr('jkt.png',self.cover if cover is None else cover)
            z.writestr('EXT.mc',json.dumps({'meta':{'song':{'title':'Song','artist':artist}},'note':[{'index':0,'beat':[0,0,1]}]}))
    def build(self,old=None):
        st=b.Stats();st.previous_sources=old or {};b.build_song(self.song,self.out,False,False,st);return st
    def test_artist_edit_preserves_media_inodes(self):
        first=self.build();audio=self.out/'media/audio/song.ogg';cover=self.out/'media/cover/song.png'
        identity=[p.stat().st_ino for p in (audio,cover)]
        self.package('Verified artist');second=self.build(first.sources)
        self.assertEqual(second.files,1);self.assertEqual(identity,[p.stat().st_ino for p in (audio,cover)])
        self.assertIn('Verified artist',(self.out/'data/charts/song/EXT.json').read_text())
    def test_size_quality_and_encoder_changes_invalidate_only_affected_asset(self):
        first=self.build()
        with patch.object(b.config,'THUMB_SIZE',128):second=self.build(first.sources)
        self.assertEqual(second.files,1)
        with Image.open(self.out/'media/thumb/song.jpg') as image: self.assertEqual(image.size,(128,128))
        with patch.object(b.config,'THUMB_SIZE',128),patch.object(b.audio_opus,'profile',return_value='new-encoder'):
            third=self.build(second.sources)
        self.assertEqual(third.files,0);self.assertEqual(third.audio_cached,1)
    def test_same_mtime_changed_source_is_detected(self):
        first=self.build();stamp=self.mcz.stat().st_mtime_ns
        self.package('New artist');os.utime(self.mcz,ns=(stamp,stamp))
        self.assertEqual(self.build(first.sources).files,1)
    def test_missing_or_corrupt_cover_rejected(self):
        self.song['cover']=''
        with self.assertRaisesRegex(ValueError,'缺少封面'):self.build()
        self.song['cover']='jkt.png';self.package(cover=b'not an image')
        with self.assertRaisesRegex(ValueError,'无法解码'):self.build()
    def test_missing_level_or_conflicting_artist_rejected(self):
        self.song['charts'][0]['level']=''
        with self.assertRaisesRegex(ValueError,'缺少等级'):self.build()
        self.song['charts'][0]['level']='8';self.song['artist']='Conflict'
        with self.assertRaisesRegex(ValueError,'不一致'):self.build()
    def test_deleted_output_rebuilt(self):
        first=self.build();(self.out/'media/cover/song.png').unlink()
        self.assertEqual(self.build(first.sources).files,1)

class Collection(unittest.TestCase):
    def test_old_references_grace_and_current_index_protect_assets(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'data').mkdir();(root/'static').mkdir();(root/'index.html').write_text('<script src="static/current.11111111111111111111.js"></script>')
            refs=[];now=time.time()
            for i in range(5):
                p=root/'static'/f'a.{i:020x}.js';p.write_text('old');os.utime(p,(now-20*86400,now-20*86400));refs.append(p.relative_to(root).as_posix())
            (root/'data/library.json').write_text(json.dumps({'songs':[{'assets':{'audio':refs[0]}}]}))
            snapshots=[{'at':now-10*86400,'paths':[refs[0],refs[1]]}]+[{'at':now-8*86400+i,'paths':[refs[i+2]]} for i in range(3)]
            (root/gc.HISTORY).write_text(json.dumps({'schema':1,'snapshots':snapshots}))
            self.assertEqual([p.relative_to(root).as_posix() for p in gc.candidates(root,now)], [refs[1]])
            snapshots[0]['at']=now-86400
            (root/gc.HISTORY).write_text(json.dumps({'schema':1,'snapshots':snapshots}))
            self.assertEqual(gc.candidates(root,now),[])
    def test_no_history_refuses_collection(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):gc.candidates(Path(d))

if __name__=='__main__':unittest.main()
