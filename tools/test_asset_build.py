"""Regression tests for safe hash retention and orphan collection."""
import json, os, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import site_gc as gc


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
