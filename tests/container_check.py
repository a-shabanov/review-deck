"""Run the same integration suite inside the Compose deployment.

Usage: python tests/container_check.py [--build]
Requires Docker Compose v2 and host ffmpeg; makes a temporary project and removes its containers.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import unittest
import test_onprem as core

DOCKER = shutil.which('docker') or 'docker'
BUILD = '--build' in sys.argv

class ContainerTests(core.OnPremTests):
    @classmethod
    def start(cls):
        if not hasattr(cls, 'compose'):
            project = cls.base / 'project'; project.mkdir()
            for rel in ('Dockerfile', 'compose.yaml', '.dockerignore', 'server.py', 'requirements.txt'):
                shutil.copy2(core.PROJECT / rel, project / rel)
            shutil.copytree(core.PROJECT / 'static', project / 'static')
            secrets = project / 'secrets'; secrets.mkdir(mode=0o700)
            shutil.copy2(cls.secret, secrets / 'review-password.txt')
            os.chmod(secrets / 'review-password.txt', 0o444)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); cls.port = sock.getsockname()[1]
            cls.container_env = dict(os.environ, REVIEW_DECK_LIBRARY=str(cls.lib), REVIEW_DECK_DATA_DIR=str(cls.data),
                                     REVIEW_DECK_PORT=str(cls.port), REVIEW_DECK_PUBLIC_ORIGIN='',
                                     REVIEW_DECK_UID=str(os.getuid()), REVIEW_DECK_GID=str(os.getgid()))
            cls.compose = [DOCKER, 'compose', '--project-directory', str(project), '-p', f'review-deck-test-{os.getpid()}']
            if BUILD: subprocess.run(cls.compose + ['build'], env=cls.container_env, check=True)
        subprocess.run(cls.compose + ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60'],
                       env=cls.container_env, check=True)
        # Native-startup guard tests use the host CLI against the container's existing data lock.
        cls.cmd = [sys.executable, str(core.PROJECT / 'server.py'), '--on-prem', str(cls.lib),
                   '--data-dir', str(cls.data), '--password-file', str(cls.secret), '--port', str(cls.port)]

    @classmethod
    def stop(cls):
        subprocess.run(cls.compose + ['stop', '-t', '10'], env=cls.container_env, check=True, stdout=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):
        try:
            subprocess.run(cls.compose + ['down', '--remove-orphans'], env=cls.container_env, check=True)
        finally:
            cls.log.close(); cls.tmp.cleanup()

    def test_startup_guards(self):
        # Host flock and a Linux VM flock are different on Docker Desktop.
        # Check the real runtime user/read-only mount here; native suite covers CLI guards.
        result = subprocess.run(self.compose + ['exec', '-T', 'review-deck', 'python', '-c',
            "import os; assert os.getuid() != 0; assert not os.access('/library', os.W_OK); print('non-root; source mount is read-only')"],
            env=self.container_env, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
