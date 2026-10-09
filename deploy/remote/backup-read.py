#!/usr/bin/env python3
"""SSH forced command: allow only listing and reading completed HOJ backup files."""
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path.home() / '.hoj-backups'
FILES = {'manifest.json', 'databases.sql.gz', 'files.tar.gz', 'application-grants.sql', 'source.bundle'}


def main():
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if command == 'list':
        entries = sorted(p.name for p in ROOT.iterdir() if p.is_dir() and not p.is_symlink()
                         and re.fullmatch(r'\d{8}-\d{6}-\d{6}', p.name)
                         and (p / 'manifest.json').is_file())
        print(json.dumps(entries))
        return
    match = re.fullmatch(r'get (\d{8}-\d{6}-\d{6}) ([a-z.-]+)', command)
    if not match or match[2] not in FILES:
        raise SystemExit('Only backup list/get commands are allowed')
    path = ROOT / match[1] / match[2]
    if path.is_symlink() or path.parent.is_symlink() or not path.resolve().is_relative_to(ROOT.resolve()):
        raise SystemExit('Invalid backup path')
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            sys.stdout.buffer.write(block)


if __name__ == '__main__':
    main()
