#!/usr/bin/env python3
"""Build committed source; publish verified images and emit a digest-only override."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ('core', 'api', 'management-api', 'web', 'management-web', 'storage', 'db')


def run(*args, capture=False, cwd=None):
    p = subprocess.run(args, cwd=cwd or ROOT, check=True, text=True,
                       stdout=subprocess.PIPE if capture else None)
    return p.stdout.strip() if capture else None


def inspect(image):
    return json.loads(run('docker', 'image', 'inspect', image, capture=True))[0]


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(path)


def build(args):
    if run('git', 'status', '--porcelain', capture=True):
        raise SystemExit('Commit all source changes before building a release.')
    revision = run('git', 'rev-parse', 'HEAD', capture=True)
    out = Path(args.output).resolve() if args.output else ROOT / 'releases' / revision
    if (out / 'release.json').exists():
        raise SystemExit('Release already exists; use it or choose a new output directory.')
    out.mkdir(parents=True, exist_ok=True)
    archive = out / 'source.tar'
    run('git', 'archive', '--format=tar', '-o', str(archive), revision)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    result = {'revision': revision, 'source_sha256': digest, 'platform': 'linux/amd64',
              'images': {}, 'status': 'building'}
    save(out / 'release.json', result)
    with tempfile.TemporaryDirectory(prefix='hoj-release-') as temp:
        context = Path(temp)
        with tarfile.open(archive) as tar:
            # Git archive may contain tracked symlinks; all links must stay inside it.
            for member in tar.getmembers():
                dest = context / member.name
                if not dest.resolve().is_relative_to(context):
                    raise SystemExit('Unsafe source archive path')
                if member.issym() or member.islnk():
                    target = dest.parent / member.linkname if member.issym() else context / member.linkname
                    if not target.resolve().is_relative_to(context):
                        raise SystemExit('Unsafe source archive link')
            tar.extractall(context)
        for service in SERVICES:
            tag = f'hoj-{service}:git-{revision}'
            if service == 'db':
                # Mirror the exact upstream database build, retaining its metadata.
                run('docker', 'pull', '--platform', 'linux/amd64', args.db_image)
                run('docker', 'tag', args.db_image, tag)
            else:
                dockerfile = f'deploy/remote/Dockerfile.{service}'
                command = ['docker', 'build', '--platform', 'linux/amd64', '--network', 'host',
                           '--progress', 'plain', '-f', dockerfile, '-t', tag,
                           '--label', f'org.opencontainers.image.revision={revision}',
                           '--label', f'org.opencontainers.image.source={args.source_url}',
                           '--label', f'moe.osa.hoj.source-sha256={digest}']
                if args.pull:
                    command.append('--pull')
                # These are temporary network proxy settings, never service secrets.
                proxy = os.environ.get('HOJ_BUILD_PROXY')
                if proxy:
                    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
                        command += ['--build-arg', f'{key}={proxy}']
                if service == 'storage':
                    command += ['--build-arg', 'GOPROXY=https://proxy.golang.org,direct']
                run(*command, '.', cwd=context)
            image = inspect(tag)
            if image['Architecture'] != 'amd64' or image['Os'] != 'linux':
                raise SystemExit('Wrong platform: ' + tag)
            result['images'][service] = {'tag': tag, 'id': image['Id'],
                                         'upstream_digests': image.get('RepoDigests', [])}
            save(out / 'release.json', result)
    result['status'] = 'built'
    save(out / 'release.json', result)
    print('Built committed source. Manifest:', out / 'release.json')


def publish(args):
    path = Path(args.manifest).resolve()
    manifest = json.loads(path.read_text())
    revision = manifest['revision']
    if not re.fullmatch('[0-9a-f]{40}', revision) or set(manifest['images']) != set(SERVICES):
        raise SystemExit('Incomplete or invalid release')
    if manifest['status'] not in ('built', 'published'):
        raise SystemExit('Build has not completed')
    prefix = args.repository.rstrip('/')
    if not re.fullmatch(r'[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._-]+', prefix):
        raise SystemExit('Use registry-host/project, without a URL scheme')
    # Validate the entire set before the first push, including previously-pushed retries.
    for service, record in manifest['images'].items():
        image = inspect(record['tag'])
        if image['Id'] != record['id'] or image['Architecture'] != 'amd64' or image['Os'] != 'linux':
            raise SystemExit('Image changed since build: ' + service)
        if service != 'db':
            labels = image['Config'].get('Labels') or {}
            if labels.get('org.opencontainers.image.revision') != revision or labels.get('moe.osa.hoj.source-sha256') != manifest['source_sha256']:
                raise SystemExit('Source labels mismatch: ' + service)
    for service, record in manifest['images'].items():
        target = f'{prefix}/{service}:git-{revision}'
        run('docker', 'tag', record['id'], target)
        run('docker', 'push', target)
        candidates = [d for d in inspect(target).get('RepoDigests', [])
                      if d.startswith(f'{prefix}/{service}@sha256:')]
        if len(candidates) != 1:
            raise SystemExit('Cannot resolve published digest: ' + service)
        locked = candidates[0]
        run('docker', 'pull', '--platform', 'linux/amd64', locked)
        if inspect(locked)['Id'] != record['id']:
            raise SystemExit('Pull-back verification failed: ' + service)
        record['published'] = locked
        save(path, manifest)
    manifest['status'] = 'published'
    save(path, manifest)
    override = {'services': {s: {'image': manifest['images'][s]['published']} for s in SERVICES}}
    save(path.parent / 'compose.images.json', override)
    print('Published and pulled back all seven images. Digest override:', path.parent / 'compose.images.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('build')
    b.add_argument('--output')
    b.add_argument('--pull', action='store_true', help='Refresh base images before building')
    b.add_argument('--db-image', default='mariadb:11.8.9', help='Exact upstream database release')
    b.add_argument('--source-url', default='https://github.com/hitszosa/HOJ')
    b.set_defaults(function=build)
    p = sub.add_parser('publish')
    p.add_argument('manifest')
    p.add_argument('--repository', default='harbor.osa.moe/hoj')
    p.set_defaults(function=publish)
    args = parser.parse_args()
    args.function(args)


if __name__ == '__main__':
    main()
