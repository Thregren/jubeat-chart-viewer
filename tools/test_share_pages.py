import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from build_share_pages import build_share_pages,song_key

class SharePages(unittest.TestCase):
    def test_static_metadata_is_escaped_and_images_are_small(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'data').mkdir();(root/'songs').mkdir();Image.new('RGB',(1800,1800),'red').save(root/'songs/cover.png')
            song={'id':'音乐魔方/a&b','title':'<歌>" & </title><script>alert(1)</script>','artist':'甲 & 乙','assets':{'cover':'songs/cover.png'}}
            (root/'data/library.json').write_text(json.dumps({'songs':[song]}))
            out=root/'out';result=build_share_pages(root,out,version='0.6.36');self.assertEqual(result['songs'],1)
            text=(out/result['pages'][0]['page']).read_text();self.assertIn('property="og:image"',text);self.assertIn('&lt;script&gt;',text);self.assertNotIn('<script>alert',text);self.assertIn('name="jubeat-share-song"',text)
            image=out/result['pages'][0]['image'];self.assertLess(image.stat().st_size,200000)
            with Image.open(image)as pic:self.assertEqual(pic.size,(300,300))
            self.assertEqual(song_key(song['id']),result['pages'][0]['page'].split('/')[-1].split('.')[0])
    def test_no_arbitrary_files_or_external_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'data').mkdir();(root/'outside.png').write_bytes(b'secret')
            rows=[{'id':'v/a','title':'a','assets':{'cover':'../outside.png'}},{'id':'v/b','title':'b','assets':{'cover':'https://example.com/photo.jpg'}}]
            (root/'data/library.json').write_text(json.dumps({'songs':rows}));out=root/'out';result=build_share_pages(root,out)
            for row in result['pages']:self.assertEqual(row['image'],'static/apple-touch-icon-v2.png')
            self.assertEqual(len(list((out/'share').glob('*.html'))),2)
    def test_output_symlink_cannot_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);out=root/'out';outside=root/'outside';out.mkdir();outside.mkdir();(out/'share').symlink_to(outside,target_is_directory=True)
            with self.assertRaises(ValueError):build_share_pages(root,out,songs=[{'id':'x'}])
            self.assertEqual(list(outside.iterdir()),[])
    def test_duplicate_ids_rejected(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp)
            with self.assertRaises(ValueError):build_share_pages(root,root/'out',songs=[{'id':'x'},{'id':'x'}])

if __name__=='__main__':unittest.main()
