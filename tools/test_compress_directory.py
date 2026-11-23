import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave
import os
import shutil
from PIL import Image
import compress_directory
from compress_directory import convert,read,write,probe,update_cover


class CoverCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.source = root / 'source.png'
        self.native = root / 'native.png'
        self.cover = root / 'out/cover.png'
        self.thumb = self.cover.with_name('thumb.jpg')
        Image.new('RGB', (160, 120), 'red').save(self.native)
        os.link(self.native, self.source)

    def refresh(self, prior):
        return update_cover(self.source, self.native, self.cover, self.thumb, prior)

    def replace_source(self, color='blue'):
        mtime = self.source.stat().st_mtime_ns
        replacement = self.native.with_name('new.png')
        staged_source = self.source.with_name('new-source.png')
        Image.new('RGB', (160, 120), color).save(replacement)
        os.utime(replacement, ns=(mtime, mtime))
        os.link(replacement, staged_source)
        os.replace(replacement, self.native)
        os.replace(staged_source, self.source)

    def test_unchanged_cover_skips_decode_and_recipe_change_rebuilds(self):
        first = self.refresh({})
        self.assertTrue(self.source.samefile(self.cover))
        with patch.object(Image, 'open', wraps=Image.open) as decode:
            self.assertEqual(self.refresh(first), first)
            decode.assert_not_called()
        with patch.object(compress_directory, 'THUMBNAIL_SIZE', (40, 40)):
            current = self.refresh(first)
        self.assertNotEqual(first['recipe'], current['recipe'])
        with Image.open(self.thumb) as thumb:
            self.assertEqual(thumb.size, (40, 30))

    def test_atomic_source_replacement_refreshes_link_and_cross_volume_copy(self):
        for cross_volume in (False, True):
            with self.subTest(cross_volume=cross_volume):
                if cross_volume:
                    self.replace_source('red')

                def refresh(prior):
                    if cross_volume:
                        with patch.object(os, 'link', side_effect=OSError(errno.EXDEV, 'cross-device link')):
                            return self.refresh(prior)
                    return self.refresh(prior)

                prior = refresh({})
                self.assertEqual(self.source.samefile(self.cover), not cross_volume)
                original = self.source.stat()
                self.replace_source()
                self.assertEqual(self.source.stat().st_mtime_ns, original.st_mtime_ns)
                self.assertNotEqual(self.source.stat().st_ino, original.st_ino)
                current = refresh(prior)
                self.assertNotEqual(current['inputs'], prior['inputs'])
                self.assertEqual(self.cover.read_bytes(), self.source.read_bytes())
                with Image.open(self.thumb) as thumb:
                    self.assertGreater(thumb.getpixel((0, 0))[2], 240)
                with patch.object(Image, 'open', wraps=Image.open) as decode:
                    self.assertEqual(refresh(current), current)
                    decode.assert_not_called()

    def test_failed_thumbnail_generation_preserves_previous_pair(self):
        prior = self.refresh({})
        before = (self.cover.read_bytes(), self.thumb.read_bytes())
        self.replace_source()
        with patch.object(Image.Image, 'save', side_effect=OSError('JPEG write failed')):
            with self.assertRaisesRegex(OSError, 'JPEG write failed'):
                self.refresh(prior)
        self.assertEqual((self.cover.read_bytes(), self.thumb.read_bytes()), before)
        self.assertEqual(set(self.cover.parent.iterdir()), {self.cover, self.thumb})
        self.assertNotEqual(self.refresh(prior), prior)

    def test_failed_thumbnail_replacement_rolls_back_cover(self):
        prior = self.refresh({})
        self.replace_source()
        replace = os.replace

        def fail_thumbnail(staged, destination):
            if destination == self.thumb:
                raise OSError('thumbnail replacement failed')
            replace(staged, destination)

        with patch.object(os, 'replace', side_effect=fail_thumbnail):
            with self.assertRaisesRegex(OSError, 'thumbnail replacement failed'):
                self.refresh(prior)
        self.assertEqual(prior['outputs'], [compress_directory.cover_fingerprint(path)
                                           for path in (self.cover, self.thumb)])
        updated = self.refresh(prior)
        self.assertNotEqual(updated['outputs'], prior['outputs'])

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
            self.assertIn('cover', read(report/'转码状态.json')['done'][id])
            exported=read(out/'data/versions/v.json')['songs'][0]
            self.assertNotIn('metadataEvidence',exported);self.assertNotIn('preview',exported['assets'])
            self.assertEqual(exported['cover'],'cover.png')
            self.assertEqual(probe(out/exported['assets']['audio'])['streams'][0]['codec_name'],'opus')
            self.assertEqual(read(out/exported['assets']['chart:EXT'])['note'],chart['note'])
            with Image.open(out/exported['assets']['thumb']) as thumb:self.assertEqual(thumb.size,(96,96))
            self.assertEqual(list((out/'songs').rglob('*.wav')),[]);self.assertTrue((native/'bgm.wav').exists())

if __name__=='__main__':unittest.main()
