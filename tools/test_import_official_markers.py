"""Recovered collaboration art survives a later HDD import with placeholder images."""
import json, subprocess, sys, tempfile, unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('import_official_markers.py')

class ImportMarkers(unittest.TestCase):
    def test_merge_preserves_recovered_art_and_curated_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); dest = root/'dest'; banks = root/'src/out/markers'
            dest.mkdir(); banks.mkdir(parents=True)
            designs = []
            for num in (1, 41):
                directory = f'tex_l44_tm{num:04d}'
                (dest/directory).mkdir()
                (dest/directory/f'TM{num:04d}_MA00.png').write_bytes(b'recovered')
                designs.append(dict(id=f'tm{num:04d}', num=num, dir=directory, prefix=f'TM{num:04d}', name=f'Curated {num}', release='Qubell（2016-07-14）', ma=1, h={}, fr=0))
            (dest/'manifest.json').write_text(json.dumps(dict(designs=designs)))
            for num in (1, 41, 42):
                directory = banks/f'tex_l44_tm{num:04d}'; directory.mkdir()
                (directory/f'TM{num:04d}_MA00.png').write_bytes(b'new source')
                (directory/f'TM{num:04d}_H400.png').write_bytes(b'perfect')
            (banks/'marker_names.json').write_text(json.dumps({'markers':[{'tm':41,'art_status':'placeholder'},{'tm':1,'name_en':'New label'}]}))
            subprocess.run([sys.executable,str(SCRIPT),'--src',str(root/'src'),'--dest',str(dest)],check=True,capture_output=True)
            result = json.loads((dest/'manifest.json').read_text())['designs']
            self.assertEqual([d['num'] for d in result],[1,41,42])
            self.assertEqual((dest/'tex_l44_tm0041/TM0041_MA00.png').read_bytes(),b'recovered')
            self.assertEqual(result[1],designs[1])
            self.assertEqual(result[0]['name'],'Curated 1')
            self.assertEqual(result[0]['release'],designs[0]['release'])
            self.assertEqual((dest/'tex_l44_tm0001/TM0001_MA00.png').read_bytes(),b'new source')
            self.assertEqual(result[2]['h'],{'4':1})

if __name__ == '__main__': unittest.main()
