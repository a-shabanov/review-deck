"""End-to-end tests: isolated synthetic library, real Waitress and ffmpeg; no user media."""
import base64
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import urlencode

PROJECT = Path(__file__).resolve().parents[1]

class OnPremTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='review-deck-test-')
        cls.base = Path(cls.tmp.name)
        cls.lib = cls.base / 'library'; cls.lib.mkdir()
        cls.data = cls.base / 'data'; cls.data.mkdir()
        cls.password = 'test-only-password-0123456789'
        cls.secret = cls.base / 'password.txt'; cls.secret.write_text(cls.password)
        cls.rel = 'папка/тест.mp4'
        video = cls.lib / cls.rel; video.parent.mkdir()
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12',
                        '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        cls.video = video.read_bytes()
        (cls.base / 'outside.txt').write_text('not in library')
        (cls.lib / 'escape.mp4').symlink_to(cls.base / 'outside.txt')
        (cls.data / 'drawings').mkdir()
        (cls.data / 'drawings' / 'escape').symlink_to(cls.base, target_is_directory=True)
        cls.log = open(cls.base / 'server.log', 'w+')
        cls.start()

    @classmethod
    def start(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); cls.port = sock.getsockname()[1]
        cls.cmd = [sys.executable, str(PROJECT / 'server.py'), '--on-prem', str(cls.lib),
                   '--data-dir', str(cls.data), '--password-file', str(cls.secret), '--port', str(cls.port)]
        cls.proc = subprocess.Popen(cls.cmd, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            if cls.proc.poll() is not None:
                cls.log.seek(0); raise RuntimeError(cls.log.read())
            try:
                if cls.req('/healthz', auth=False)[0] == 200: return
            except OSError: pass
            time.sleep(.05)
        raise RuntimeError('server did not start')

    @classmethod
    def stop(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=15)

    @classmethod
    def tearDownClass(cls):
        cls.stop(); cls.log.close(); cls.tmp.cleanup()

    @classmethod
    def req(cls, path, method='GET', body=None, headers=None, auth=True):
        hs = dict(headers or {})
        if auth:
            hs.setdefault('Authorization', 'Basic ' + base64.b64encode(('review:' + cls.password).encode()).decode())
        if body is not None:
            body = json.dumps(body).encode(); hs.setdefault('Content-Type', 'application/json')
        con = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=30)
        try:
            con.request(method, path, body=body, headers=hs)
            res = con.getresponse(); return res.status, dict(res.getheaders()), res.read()
        finally: con.close()

    def test_auth_covers_ui_api_and_media(self):
        for path in ('/', '/static/app.js', '/api/state', '/api/export', '/media?rel=x', '/drawing?f=x'):
            code, hs, _ = self.req(path, auth=False)
            self.assertEqual(code, 401, path); self.assertIn('www-authenticate', {k.lower(): v for k, v in hs.items()})
        self.assertEqual(self.req('/api/catalog', 'POST', {'ops': []}, auth=False)[0], 401)
        self.assertEqual(self.req('/', headers={'Authorization': 'Basic garbage'})[0], 401)
        self.assertEqual(self.req('/healthz', auth=False)[0], 200)

    def test_library_locked_and_isolated(self):
        code, _, b = self.req('/api/state'); state = json.loads(b)
        self.assertEqual(code, 200); self.assertTrue(state['root_locked'])
        self.assertEqual(self.req('/api/root', 'POST', {'path': str(self.base)})[0], 403)
        code, _, b = self.req('/api/library')
        self.assertEqual(code, 200)
        rels = [v['rel'] for f in json.loads(b)['folders'] for v in f['videos']]
        self.assertEqual(rels, [self.rel])

    def test_traversal_and_symlinks(self):
        for rel in ('../outside.txt', '/etc/passwd', 'escape.mp4'):
            self.assertEqual(self.req('/media?' + urlencode({'rel': rel}))[0], 400, rel)
        for path in ('../preferences.json', 'escape/outside.txt', '/etc/passwd'):
            self.assertEqual(self.req('/drawing?' + urlencode({'f': path}))[0], 400, path)
        self.assertEqual(self.req('/api/marks?rel=../../escape', 'POST', {})[0], 400)
        # Existing malicious catalog ids cannot turn the avatar route into file access.
        self.assertEqual(self.req('/api/avatar?' + urlencode({'id': '../escape'}))[0], 400)

    def test_range_and_head(self):
        url = '/media?' + urlencode({'rel': self.rel})
        for rng, start, end in (('bytes=0-63', 0, 63), ('bytes=-17', len(self.video)-17, len(self.video)-1),
                                ('bytes=100-', 100, len(self.video)-1)):
            code, hs, body = self.req(url, headers={'Range': rng})
            self.assertEqual(code, 206); self.assertEqual(body, self.video[start:end+1])
            self.assertEqual(hs['Content-Range'], f'bytes {start}-{end}/{len(self.video)}')
        for rng in ('bytes=999999999-', 'bytes=8-2', 'bytes=-0', 'bytes=0-1,3-4', 'invalid'):
            self.assertEqual(self.req(url, headers={'Range': rng})[0], 416, rng)
        code, hs, body = self.req(url, method='HEAD')
        self.assertEqual(code, 200); self.assertEqual(body, b''); self.assertEqual(int(hs['Content-Length']), len(self.video))

    def test_local_mode_without_python_dependencies(self):
        local = self.base / 'local-library'; local.mkdir()
        (local / 'clip.mp4').write_bytes(self.video)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        proc = subprocess.Popen([sys.executable, '-S', str(PROJECT / 'server.py'), str(local), '--port', str(port)],
                                env=dict(os.environ, HOME=str(self.base / 'local-home')), stdout=self.log, stderr=self.log)
        try:
            for _ in range(100):
                try:
                    con = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    con.request('GET', '/api/state'); res = con.getresponse()
                    code, body = res.status, res.read(); con.close()
                    if code == 200: break
                except OSError: time.sleep(.05)
            else: self.fail('local mode did not start')
            self.assertFalse(json.loads(body)['root_locked'])
            con = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            con.request('POST', '/api/marks?rel=clip.mp4', body='{"note":"local compatibility"}', headers={'Content-Type':'application/json'})
            res = con.getresponse(); self.assertEqual(res.status, 200); res.read(); con.close()
            saved = json.loads((local / '_review' / 'marks' / 'clip.mp4.json').read_text())
            self.assertEqual(saved['note'], 'local compatibility')
        finally:
            proc.terminate(); proc.wait(timeout=10)

    def test_marks_timelines_config_catalog_export(self):
        for tl in ('', 'review'):
            url = '/api/marks?' + urlencode({'rel': self.rel, 'tl': tl})
            mark = {'status': 'ok', 'tracks': {'F': {'spans': [[.2, 1.5, 'caption']], 'label': 'test'}}}
            self.assertEqual(self.req(url, 'POST', mark)[0], 200)
            self.assertEqual(json.loads(self.req(url)[2])['tracks']['F']['spans'], [[.2, 1.5, 'caption']])
        self.assertTrue((self.data / 'marks' / (self.rel + '.json')).is_file())
        self.assertTrue((self.data / 'marks@review' / (self.rel + '.json')).is_file())
        config = {'tracks': [{'key': 'F', 'label': 'custom', 'color': '#ffffff', 'hot': 'F'}]}
        self.assertEqual(self.req('/api/config?tl=review', 'POST', config)[0], 200)
        saved = json.loads(self.req('/api/config?tl=review')[2])
        self.assertEqual(saved['tracks'][0]['label'], 'custom')
        self.assertEqual(saved['tracks'][0]['hot'], 'F')
        op = {'ops': [{'op': 'assign', 'kind': 'tags', 'name': 'Test', 'rels': [self.rel]}]}
        self.assertEqual(self.req('/api/catalog', 'POST', op)[0], 200)
        export = json.loads(self.req('/api/export')[2])
        self.assertIn(self.rel, export['videos']); self.assertTrue(export['catalog']['tags'])
        self.assertFalse((self.lib / '_review').exists())

    def test_metadata_and_previews(self):
        code, _, b = self.req('/api/meta?' + urlencode({'rel': self.rel}))
        self.assertEqual(code, 200); self.assertTrue(json.loads(b)['ok'])
        for kind in ('thumb', 'sprite'):
            code, hs, b = self.req('/api/' + kind + '?' + urlencode({'rel': self.rel}))
            self.assertEqual(code, 200); self.assertEqual(hs['Content-Type'], 'image/jpeg'); self.assertTrue(b.startswith(b'\xff\xd8'))

    def test_proxy_generation(self):
        url = '/api/proxy?' + urlencode({'rel': self.rel})
        self.assertEqual(self.req(url, 'POST', {})[0], 200)
        for _ in range(100):
            status = json.loads(self.req(url)[2])['status']
            if status in ('done', 'error'): break
            time.sleep(.1)
        self.assertEqual(status, 'done')
        self.assertEqual(self.req('/media?' + urlencode({'rel': self.rel, 'proxy': 1}))[0], 200)

    def test_drawing_upload_and_read(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=')
        payload = {'t': 1.25, 'png': 'data:image/png;base64,' + base64.b64encode(png).decode()}
        code, _, b = self.req('/api/drawing?' + urlencode({'rel': self.rel}), 'POST', payload)
        self.assertEqual(code, 200)
        url = '/drawing?' + urlencode({'f': json.loads(b)['file']})
        self.assertEqual(self.req(url)[2], png)
        payload['png'] = 'data:image/png;base64,' + base64.b64encode(b'not a png').decode()
        self.assertEqual(self.req('/api/drawing?' + urlencode({'rel': self.rel}), 'POST', payload)[0], 400)

    def test_export_skips_external_symlinks(self):
        outside = self.base / 'private.json'; outside.write_text('{"secret":"outside"}')
        marks = self.data / 'marks'; marks.mkdir(exist_ok=True)
        (marks / 'escape.json').symlink_to(outside)
        exported = json.loads(self.req('/api/export')[2])
        self.assertNotIn('escape', exported['videos'])

    def test_request_validation_and_csrf(self):
        for headers in ({'Origin': 'https://evil.invalid'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.req('/api/config', 'POST', {'tracks': []}, headers)[0], 403)
        self.assertEqual(self.req('/api/config', 'POST', headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.req('/api/config', 'POST', [1, 2])[0], 400)
        self.assertEqual(self.req('/api/config?tl=../bad')[0], 400)
        self.assertEqual(self.req('/api/marks')[0], 400)
        self.assertEqual(self.req('/missing')[0], 404)
        self.assertEqual(self.req('/api/state', method='DELETE')[0], 405)
        self.assertEqual(self.req('/api/config', 'POST', {}, {'Content-Length': str(17 * 1024 * 1024)})[0], 413)

    def test_parallel_writes_are_valid_json(self):
        def write(n):
            return self.req('/api/marks?' + urlencode({'rel': f'parallel-{n}.mp4'}), 'POST', {'note': str(n)})[0]
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            self.assertEqual(list(pool.map(write, range(20))), [200]*20)
        export = json.loads((self.data / 'all.json').read_text())
        for n in range(20): self.assertEqual(export['videos'][f'parallel-{n}.mp4']['note'], str(n))

    def test_startup_guards(self):
        for extra in (['--host', '0.0.0.0'], ['--on-prem']):
            p = subprocess.run([sys.executable, str(PROJECT / 'server.py'), *extra], capture_output=True)
            self.assertNotEqual(p.returncode, 0)
        duplicate = subprocess.run(self.cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertNotEqual(duplicate.returncode, 0); self.assertIn(b'already in use', duplicate.stderr)
        weak = self.base / 'weak'; weak.write_text('short')
        p = subprocess.run(self.cmd + ['--password-file', str(weak)], capture_output=True)
        self.assertNotEqual(p.returncode, 0); self.assertIn(b'at least 16', p.stderr)

    def test_z_restart_preserves_data(self):
        url = '/api/marks?' + urlencode({'rel': 'persistent.mp4'})
        self.assertEqual(self.req(url, 'POST', {'note': 'survives restart'})[0], 200)
        self.stop(); self.start()
        self.assertEqual(json.loads(self.req(url)[2])['note'], 'survives restart')
        self.assertEqual(self.req('/api/state', auth=False)[0], 401)

if __name__ == '__main__': unittest.main(verbosity=2)
