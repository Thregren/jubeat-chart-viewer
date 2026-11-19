"""Recoverable remote cutover for COS directory releases."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

MARKER = '.jubeat-cos-release.json'


def save(path, value):
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def prepare(stage, state_file, fingerprint):
    stage, state_file = Path(stage), Path(state_file)
    if state_file.exists():
        state = json.loads(state_file.read_text())
        if state.get('fingerprint') != fingerprint:
            raise RuntimeError('remote stage belongs to another package')
    elif stage.exists():
        raise RuntimeError('refusing unowned staging directory')
    else:
        state = {'fingerprint': fingerprint, 'phase': 'staged'}
        save(state_file, state)
    if state.get('phase', 'staged') == 'staged':
        stage.mkdir(exist_ok=True)
    return state.get('phase', 'staged')


def activate(target, stage, state_file, fingerprint, version, conf,
             run=subprocess.run, check_output=subprocess.check_output):
    target, stage, state_file, conf = map(Path, (target, stage, state_file, conf))
    old = target.with_name('.' + target.name + '-retired-' + version)
    backup = conf.with_name(conf.name + '.before-unified-' + version)
    state = json.loads(state_file.read_text())
    if state.get('fingerprint') != fingerprint:
        raise RuntimeError('remote stage belongs to another package')
    phase = state.get('phase', 'staged')

    def marker_matches(directory):
        try:
            return json.loads((directory / MARKER).read_text())['fingerprint'] == fingerprint
        except (OSError, ValueError, KeyError):
            return False

    def update(phase):
        state['phase'] = phase
        save(state_file, state)

    def command(*args):
        run(list(args), check=True, capture_output=True)

    def verify():
        command('/www/server/nginx/sbin/nginx', '-t')
        command('/www/server/nginx/sbin/nginx', '-s', 'reload')
        data = check_output(['curl', '-fsS', '--resolve', target.name + ':443:127.0.0.1',
                             'https://' + target.name + '/data/library.json'])
        if json.loads(data)['format'] != 'jubeat-directory-v1':
            raise RuntimeError('new site health check failed')

    def desired_config(original):
        if 'location /songs/' in original:
            return original
        pos = original.find('    location /media/ {')
        end = original.find('\n    }', pos)
        if pos < 0 or end <= pos:
            raise RuntimeError('media location missing')
        block = original[pos:end+6].replace('location /media/', 'location /songs/', 1) + '\n\n'
        return original[:pos] + block + original[pos:]

    if phase == 'complete':
        if not marker_matches(target):
            raise RuntimeError('completed release no longer matches target')
        return 'complete'

    if phase == 'staged':
        if old.exists() or target.is_symlink() or not target.is_dir() or not stage.is_dir():
            raise RuntimeError('unexpected activation paths')
        original = conf.read_text()
        backup.write_text(original)
        updated = desired_config(original)
        (stage / MARKER).write_text(json.dumps({'fingerprint': fingerprint}))
        if (target / '.well-known').exists():
            shutil.copytree(target / '.well-known', stage / '.well-known', dirs_exist_ok=True)
        command('chown', '-R', 'www:www', str(stage))
        update('switching')
        conf.write_text(updated)
        command('/www/server/nginx/sbin/nginx', '-t')
        target.rename(old)
        stage.rename(target)
        phase = 'switching'

    if phase == 'switching':
        # A process may have stopped between either rename. Complete only when the
        # prepared marker proves that the target is this release.
        if not old.exists() and target.is_dir() and marker_matches(stage):
            conf.write_text(desired_config(backup.read_text()))
            command('/www/server/nginx/sbin/nginx', '-t')
            target.rename(old)
        if not target.exists() and old.exists() and stage.exists():
            if not marker_matches(stage):
                raise RuntimeError('staged release no longer matches')
            stage.rename(target)
        if not old.exists() or not marker_matches(target):
            raise RuntimeError('interrupted cutover requires inspection')
        try:
            conf.write_text(desired_config(backup.read_text()))
            verify()
        except BaseException:
            conf.write_text(backup.read_text())
            target.rename(stage)
            old.rename(target)
            run(['/www/server/nginx/sbin/nginx', '-s', 'reload'], capture_output=True)
            update('staged')
            raise
        update('activated')
        phase = 'activated'

    if phase == 'activated':
        if not marker_matches(target):
            raise RuntimeError('active target no longer matches release')
        if old.exists():
            user_ini = old / '.user.ini'
            if user_ini.is_file():
                command('chattr', '-i', str(user_ini))
            shutil.rmtree(old)
        update('complete')
        return 'complete'
    raise RuntimeError('unknown activation phase: ' + str(phase))
