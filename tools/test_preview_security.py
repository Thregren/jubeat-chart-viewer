"""Static preview must not expose filesystem neighbors or hidden files."""
import functools
import http.client
import tempfile
import threading
import unittest
from pathlib import Path
from serve import RangeHandler, BoundedHTTPServer

class PreviewSecurity(unittest.TestCase):
    def test_paths_index_symlinks_and_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            parent=Path(directory);root=parent/'site';root.mkdir()
            (parent/'secret').write_text('private')
            (root/'index.html').write_text('home');(root/'audio.ogg').write_bytes(b'0123456789')
            (root/'.env').write_text('private');(root/'listing').mkdir()
            (root/'link').symlink_to(parent/'secret')
            (root/'nested').mkdir();(root/'nested/index.html').symlink_to(parent/'secret')
            httpd=BoundedHTTPServer(('127.0.0.1',0),functools.partial(RangeHandler,directory=str(root)))
            thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
            client=http.client.HTTPConnection(*httpd.server_address,timeout=3)
            try:
                for path in ['/link','/nested/','/.env','/%2eenv','/listing/']:
                    client.request('GET',path);response=client.getresponse()
                    self.assertEqual(response.status,404,path);self.assertNotIn(b'private',response.read())
                client.request('GET','/');response=client.getresponse();self.assertEqual((response.status,response.read()),(200,b'home'))
                client.request('GET','/audio.ogg',headers={'Range':'bytes=2-5'});response=client.getresponse()
                self.assertEqual((response.status,response.read()),(206,b'2345'))
            finally:
                client.close();httpd.shutdown();httpd.server_close();thread.join(3)

if __name__=='__main__':unittest.main()
