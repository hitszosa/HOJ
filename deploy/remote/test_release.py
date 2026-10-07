"""Release safety checks without contacting or changing a real registry."""
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

import release


class PublicationSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'release.json'
        self.revision = 'a' * 40
        self.source_hash = 'b' * 64
        self.data = {'revision': self.revision, 'source_sha256': self.source_hash,
                     'status': 'built', 'images': {
                         service: {'tag': f'hoj-{service}:git-{self.revision}',
                                   'id': f'sha256:{i:064x}'}
                         for i, service in enumerate(release.SERVICES, 1)}}
        self.path.write_text(json.dumps(self.data))
        self.args = types.SimpleNamespace(manifest=str(self.path), repository='harbor.osa.moe/hoj')
        self.commands = []

    def image(self, tag):
        service = next(s for s in release.SERVICES if tag.startswith(f'hoj-{s}:')
                       or f'/{s}:' in tag or f'/{s}@' in tag)
        return {'Id': self.data['images'][service]['id'], 'Architecture': 'amd64', 'Os': 'linux',
                'Config': {'Labels': {'org.opencontainers.image.revision': self.revision,
                                     'moe.osa.hoj.source-sha256': self.source_hash}},
                'RepoDigests': [f'harbor.osa.moe/hoj/{service}@sha256:' + 'c' * 64]}

    def command(self, *args, **kwargs):
        self.commands.append(args)

    def registry_missing(self, *args, **kwargs):
        return subprocess.CompletedProcess(args, 1, '', 'no such manifest: requested tag')

    def test_tampered_image_is_rejected_before_any_push(self):
        def image(tag):
            value = self.image(tag)
            if tag == self.data['images']['web']['tag']:
                value['Config']['Labels']['org.opencontainers.image.revision'] = 'd' * 40
            return value
        with patch.object(release, 'inspect', image), patch.object(release, 'run', self.command):
            with self.assertRaisesRegex(SystemExit, 'Source labels mismatch'):
                release.publish(self.args)
        self.assertEqual(self.commands, [])

    def test_registry_connection_failure_cannot_be_treated_as_missing_tag(self):
        unavailable = subprocess.CompletedProcess([], 1, '', 'TLS handshake timeout')
        with patch.object(release, 'inspect', self.image), patch.object(release, 'run', self.command), \
             patch.object(release.subprocess, 'run', return_value=unavailable):
            with self.assertRaisesRegex(SystemExit, 'Cannot verify registry tag'):
                release.publish(self.args)
        self.assertEqual(self.commands, [])

    def test_existing_commit_with_different_content_is_never_overwritten(self):
        def image(tag):
            value = self.image(tag)
            if tag.startswith('harbor.osa.moe/'):
                value['Id'] = 'sha256:' + 'd' * 64
            return value
        exists = subprocess.CompletedProcess([], 0, '{}', '')
        with patch.object(release, 'inspect', image), patch.object(release, 'run', self.command), \
             patch.object(release.subprocess, 'run', return_value=exists):
            with self.assertRaisesRegex(SystemExit, 'already has different content'):
                release.publish(self.args)
        self.assertFalse(any(c[1] == 'push' for c in self.commands))

    def test_partial_upload_cannot_produce_a_deployment_lock(self):
        def command(*args, **kwargs):
            self.command(*args, **kwargs)
            if args[1] == 'push' and '/api:' in args[-1]:
                raise subprocess.CalledProcessError(1, args)
        with patch.object(release, 'inspect', self.image), patch.object(release, 'run', command), \
             patch.object(release.subprocess, 'run', self.registry_missing):
            with self.assertRaises(subprocess.CalledProcessError):
                release.publish(self.args)
        self.assertFalse(self.path.with_name('compose.images.json').exists())
        self.assertEqual(json.loads(self.path.read_text())['status'], 'built')

    def test_success_requires_all_seven_images_and_locks_only_digests(self):
        with patch.object(release, 'inspect', self.image), patch.object(release, 'run', self.command), \
             patch.object(release.subprocess, 'run', self.registry_missing):
            release.publish(self.args)
        locked = json.loads(self.path.with_name('compose.images.json').read_text())['services']
        self.assertEqual(set(locked), set(release.SERVICES))
        self.assertTrue(all('@sha256:' in v['image'] for v in locked.values()))
        self.assertEqual(json.loads(self.path.read_text())['status'], 'published')

    def test_startup_rejects_a_replaced_local_image(self):
        def image(tag):
            value = self.image(tag)
            if tag == self.data['images']['web']['tag']:
                value['Id'] = 'sha256:' + 'd' * 64
            return value
        with patch.object(release, 'inspect', image):
            with self.assertRaisesRegex(SystemExit, 'Built image was replaced'):
                release.config(self.args)
        self.assertFalse(self.path.with_name('compose.start.json').exists())

    def test_startup_rejects_a_published_release_missing_one_digest(self):
        self.data['status'] = 'published'
        for service, record in self.data['images'].items():
            if service != 'db':
                record['published'] = f'harbor.osa.moe/hoj/{service}@sha256:' + 'c' * 64
        self.path.write_text(json.dumps(self.data))
        with self.assertRaisesRegex(SystemExit, 'Missing registry digest'):
            release.config(self.args)
        self.assertFalse(self.path.with_name('compose.start.json').exists())


if __name__ == '__main__':
    unittest.main()
