from pathlib import Path
import tempfile
import unittest
from finalize_frontend import finalize
from site_transaction import SiteTransaction

HOME='''<html><head><title>Viewer</title><link href="static/new.css"></head><body><input id="search"><button id="btnPopular">热门</button><select id="versionFilter"></select><img id="cover"><h2 id="npTitle"></h2><div id="npArtist"></div><script src="static/new.js"></script></body></html>'''
SHARE='''<html><head><title>Song title</title><meta name="jubeat-share-song" content="v/song"><meta name="jubeat-share-root" content="https://example.org/"><meta property="og:image" content="https://example.org/cover.jpg"><link rel="canonical" href="https://example.org/share/song.html"></head><body><img id="cover" src="cover.jpg"><h2 id="npTitle">Song</h2><script src="static/old.js"></script></body></html>'''
class FrontendFinalization(unittest.TestCase):
    def test_publish_preserves_extensions_and_rebuilds_old_share_shell(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'site';(root/'static').mkdir(parents=True);(root/'share').mkdir()
            tag='<script src="/static/addon.js" data-site-extension="session"></script>'
            (root/'static/addon.js').write_text('extension');(root/'index.html').write_text(HOME.replace('</body>',tag+'</body>'))
            (root/'share/song.html').write_text(SHARE)
            with SiteTransaction(root) as tx:
                (tx.stage/'index.html').unlink();(tx.stage/'index.html').write_text(HOME)
                tx.publish()
            home=(root/'index.html').read_text();share=(root/'share/song.html').read_text()
            self.assertIn(tag,home);self.assertIn(tag,share)
            self.assertIn('id="btnPopular"',share);self.assertIn('../static/new.css',share);self.assertIn('../static/new.js',share);self.assertNotIn('old.js',share)
            for value in ['content="v/song"','Song title','content="https://example.org/cover.jpg"','src="cover.jpg"','>Song</h2>']:
                self.assertIn(value,share)
            before=(home,share);finalize(root,root);self.assertEqual(before,((root/'index.html').read_text(),(root/'share/song.html').read_text()))
    def test_missing_extension_blocks_publication_without_changing_live_site(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'site';root.mkdir();old=HOME.replace('</body>','<script src="static/missing.js" data-site-extension="required"></script></body>');(root/'index.html').write_text(old)
            with SiteTransaction(root) as tx:
                (tx.stage/'index.html').unlink();(tx.stage/'index.html').write_text(HOME)
                with self.assertRaisesRegex(ValueError,'missing'):tx.publish()
            self.assertEqual((root/'index.html').read_text(),old)
    def test_external_extension_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'index.html').write_text(HOME.replace('</body>','<script src="https://elsewhere.test/code.js" data-site-extension></script></body>'))
            with self.assertRaises(ValueError):finalize(root)
if __name__=='__main__':unittest.main()
