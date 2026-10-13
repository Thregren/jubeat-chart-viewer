"""JDK-only importer and server regressions; no emulator or SDK required."""
import argparse, shutil, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--network',action='store_true');args=p.parse_args()
if not shutil.which('javac') or not shutil.which('java'):
    raise SystemExit('JDK required for Android resource checks')
source=ROOT/'android/app/src/world/thregren/jubeatviewer'
with tempfile.TemporaryDirectory(prefix='jubeat-java-test-') as td:
    files=[source/(name+'.java') for name in ['ArchiveImport','LocalServer','HttpRange','PreferenceRules']]
    files.extend(ROOT/'android/test'/(name+'.java') for name in ['ArchiveImportTest','LocalServerTest','PreferenceRulesTest'])
    subprocess.run(['javac','-d',td,*map(str,files)],check=True)
    subprocess.run(['java','-cp',td,'world.thregren.jubeatviewer.ArchiveImportTest'],check=True)
    subprocess.run(['java','-cp',td,'world.thregren.jubeatviewer.PreferenceRulesTest'],check=True)
    if args.network: subprocess.run(['java','-cp',td,'world.thregren.jubeatviewer.LocalServerTest'],check=True)
