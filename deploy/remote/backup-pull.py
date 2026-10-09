#!/usr/bin/env python3
"""Pull completed backups over restricted SSH and verify before retaining them."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', required=True)
    p.add_argument('--port', type=int, default=22)
    p.add_argument('--key', required=True)
    p.add_argument('--known-hosts', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    os.umask(0o077)
    root = Path(args.output).resolve()
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    known_hosts = str(Path(args.known_hosts).resolve()).replace('\\', '\\\\').replace('"', '\\"')
    ssh = ['ssh', '-F', '/dev/null', '-p', str(args.port), '-i', args.key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile="' + known_hosts + '"',
           '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', args.host]
    with (root / '.pull.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        response = subprocess.run([*ssh, 'list'], capture_output=True, check=True, timeout=60)
        stamps = json.loads(response.stdout)
        if not stamps:
            raise SystemExit('No complete server backups')
        for stamp in stamps:
            if not re.fullmatch(r'\d{8}-\d{6}-\d{6}', stamp):
                raise SystemExit('Invalid backup stamp')
            if (root / stamp / 'manifest.json').is_file():
                continue
            stage = root / ('.partial-' + stamp)
            if stage.exists():
                shutil.rmtree(stage)
            stage.mkdir(mode=0o700)
            try:
                raw = subprocess.check_output([*ssh, 'get ' + stamp + ' manifest.json'], timeout=60)
                manifest = json.loads(raw)
                if manifest['stamp'] != stamp or set(manifest['files']) != {
                    'databases.sql.gz', 'files.tar.gz', 'application-grants.sql', 'source.bundle'}:
                    raise RuntimeError('Incomplete backup manifest')
                for name, info in manifest['files'].items():
                    path = stage / name
                    with path.open('wb') as out:
                        subprocess.run([*ssh, 'get ' + stamp + ' ' + name], stdout=out,
                                       stderr=subprocess.PIPE, check=True, timeout=900)
                    h = hashlib.sha256()
                    with path.open('rb') as f:
                        for block in iter(lambda: f.read(1024 * 1024), b''):
                            h.update(block)
                    if path.stat().st_size != info['bytes'] or h.hexdigest() != info['sha256']:
                        raise RuntimeError('Backup checksum mismatch: ' + name)
                    path.chmod(0o600)
                (stage / 'manifest.json').write_bytes(raw)
                stage.rename(root / stamp)
                print('Verified independent backup:', stamp, flush=True)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        complete = sorted(p for p in root.iterdir() if p.is_dir()
                          and re.fullmatch(r'\d{8}-\d{6}-\d{6}', p.name) and (p / 'manifest.json').is_file())
        for old in complete[:-30]:
            shutil.rmtree(old)
        (root / 'last-success.json').write_text(json.dumps({'latest': stamps[-1], 'status': 'verified'}) + '\n')


if __name__ == '__main__':
    main()
