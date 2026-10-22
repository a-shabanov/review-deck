"""review-deck: local video review server.

usage: python3 server.py [library_folder] [--port 8765]
       python3 server.py --on-prem /library --data-dir /data --password-file /run/secrets/password --host 0.0.0.0

Serves the web app (static/), the videos (with HTTP Range so the player can seek) and a small JSON API.
Results live in --data-dir, or in <library>/_review/ in local mode:
  marks/<relative path>.json   one file per video: status (ok / defect), spans per key track, drawings
  drawings/<relative path>/    PNG snapshots of annotated still frames
  thumbs/, sprites/, proxy/    caches (safe to delete)
  config.json                  key -> track label / colour
  catalog.json                 actresses and tags, and which videos they belong to (many-to-many)
  avatars/                     actress avatar crops (cache)
  all.json                     everything merged (written by /api/export and on every save)
"""
import json, os, sys, subprocess, threading, time, mimetypes, urllib.parse, re, base64, hashlib
import argparse, hmac, logging, shutil, tempfile, fcntl
from http import HTTPStatus
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, WSGIRequestHandler, make_server
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, 'static')
PREFS = os.path.expanduser('~/.config/review-deck.json')
DATA_DIR = None
ROOT_LOCKED = False
AUTH_USER = 'review'
AUTH_PASSWORD = None
PUBLIC_ORIGIN = None
MAX_BODY = 16 * 1024 * 1024
write_lock = threading.RLock()
log = logging.getLogger('review-deck')
VIDEO_EXT = {'.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.ts', '.flv', '.mpg', '.mpeg'}
DEFAULT_TRACKS = [
    {'key': 'F', 'label': 'action', 'color': '#ff4d6d'},
    {'key': 'C', 'label': 'close-up', 'color': '#4dabff'},
    {'key': 'V', 'label': 'face', 'color': '#ffd23f'},
    {'key': 'B', 'label': 'брак', 'color': '#9b5de5'},
    {'key': 'G', 'label': 'G', 'color': '#3ddc97'},
    {'key': 'T', 'label': 'T', 'color': '#ff9f1c'},
    {'key': 'Q', 'label': 'Q', 'color': '#f15bb5'},
    {'key': 'E', 'label': 'E', 'color': '#00f5d4'},
]

state = {'root': None}
lock = threading.Lock()
gen_pool = ThreadPoolExecutor(3)          # thumbnails / sprites / probes
proxy_pool = ThreadPoolExecutor(1)        # proxies are heavy: one at a time
pending = {}                              # cache path -> Future
proxy_jobs = {}                           # rel -> 'queued' | 'running' | 'done' | 'error'


def load_prefs():
    try: return json.load(open(PREFS))
    except Exception: return {}

def save_prefs(p):
    atomic_json(PREFS, p)

def root(): return state['root']
def confined(base, *parts):
    """Resolve symlinks as well as '..'; never serve or write outside a mount."""
    base = os.path.realpath(base)
    p = os.path.realpath(os.path.join(base, *parts))
    if os.path.commonpath((base, p)) != base: raise ValueError('outside allowed directory')
    return p

def rdir(*parts):
    base = DATA_DIR or os.path.join(root(), '_review')
    if len(parts) > 1: return confined(confined(base, parts[0]), *parts[1:])
    return confined(base, *parts)

def safe_rel(rel):
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or '\x00' in rel:
        raise ValueError('invalid relative path')
    return confined(root(), rel)

def atomic_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.review-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def atomic_bytes(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.review-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(value); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def cache_name(rel, ext):
    h = hashlib.sha1(rel.encode()).hexdigest()[:16]
    return h + ext

# ------------------------------------------------------------------ metadata (ffprobe), cached in _review/meta.json
_meta = None
def meta_all():
    global _meta
    if _meta is None:
        try: _meta = json.load(open(rdir('meta.json')))
        except Exception: _meta = {}
    return _meta

def probe(rel):
    m = meta_all()
    p = safe_rel(rel); st = os.stat(p)
    cur = m.get(rel)
    if cur and cur.get('size') == st.st_size and cur.get('mtime') == int(st.st_mtime): return cur
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,codec_name:format=duration',
                        '-of', 'json', p], capture_output=True, text=True)
    info = {'size': st.st_size, 'mtime': int(st.st_mtime), 'duration': 0, 'w': 0, 'h': 0, 'fps': 30, 'codec': '', 'ok': False}
    try:
        j = json.loads(r.stdout); s = (j.get('streams') or [{}])[0]
        num, den = (s.get('r_frame_rate') or '30/1').split('/')
        info.update(duration=float(j['format']['duration']), w=s.get('width', 0), h=s.get('height', 0),
                    fps=round(float(num) / float(den or 1), 3) if float(den or 1) else 30, codec=s.get('codec_name', ''), ok=True)
    except Exception:
        info['error'] = (r.stderr or 'ffprobe failed').strip().splitlines()[-1][:200] if r.stderr else 'ffprobe failed'
    with lock:
        m[rel] = info
        atomic_json(rdir('meta.json'), m)
    return info

# ------------------------------------------------------------------ thumbnails, scrub sprites, proxies
def make_thumb(rel, out):
    info = probe(rel); t = max(0.0, info['duration'] * 0.3)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', safe_rel(rel), '-frames:v', '1', '-vf', 'thumbnail=50,scale=480:-2', '-q:v', '4', out])   # most typical of 50 frames: no black flashes
    return out

SPRITE_N = 100   # 10 x 10 frames, 160 x 90 each
def make_sprite(rel, out):
    info = probe(rel); d = max(1.0, info['duration'])
    # keyframes only: fast even for long files; fps picks ~100 evenly spaced frames out of them
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-skip_frame', 'nokey', '-i', safe_rel(rel), '-an',
                    '-vf', f"fps={SPRITE_N / d:.5f},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=10x10",
                    '-frames:v', '1', '-q:v', '5', out])
    return out

def cached(kind, rel, fn, ext='.jpg'):
    out = rdir(kind, cache_name(rel, ext)); os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(safe_rel(rel)): return out
    with lock:
        f = pending.get(out)
        if f is None: f = pending[out] = gen_pool.submit(fn, rel, out)
    try: f.result(timeout=300)
    finally:
        with lock: pending.pop(out, None)
    return out if os.path.exists(out) else None

def proxy_path(rel): return rdir('proxy', cache_name(rel, '.mp4'))

def make_proxy(rel):
    """all-intra 540p proxy: every frame is a keyframe, so reverse play and frame stepping are smooth"""
    out = proxy_path(rel); tmp = out + '.part.mp4'; os.makedirs(os.path.dirname(out), exist_ok=True)
    proxy_jobs[rel] = 'running'
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', safe_rel(rel), '-vf', 'scale=-2:540', '-c:v', 'libx264', '-preset', 'veryfast',
                        '-crf', '26', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp])
    if r.returncode == 0: os.replace(tmp, out); proxy_jobs[rel] = 'done'
    else: proxy_jobs[rel] = 'error'

# ------------------------------------------------------------------ library + marks
# timelines: independent sets of marks per video. '' = the main one (marks/), others in marks@<name>/ with their own config@<name>.json
def tl_ok(tl):
    if tl and not re.fullmatch(r'[a-z0-9_-]{1,20}', tl): raise ValueError('timeline')
    return tl or ''
def marks_path(rel, tl=''): return rdir('marks' + ('@' + tl if tl else ''), rel + '.json')

def read_marks(rel, tl=''):
    try: return json.load(open(marks_path(rel, tl)))
    except Exception: return None

def scan():
    r = root(); folders = {}
    try: ids = json.load(open(rdir('ids.json')))          # optional short ids from the project's tools: {rel: 's01'}
    except Exception: ids = {}
    for dp, dns, fns in os.walk(r):
        dns[:] = sorted(d for d in dns if not d.startswith(('.', '_')))
        vids = []
        for fn in sorted(fns, key=str.lower):
            if fn.startswith('.') or os.path.splitext(fn)[1].lower() not in VIDEO_EXT: continue
            rel = os.path.relpath(os.path.join(dp, fn), r)
            try: p = safe_rel(rel); st = os.stat(p)
            except (ValueError, OSError): continue
            mk = read_marks(rel) or {}; mi = meta_all().get(rel, {})
            vids.append({'rel': rel, 'name': fn, 'code': ids.get(rel, ''), 'size': st.st_size, 'mtime': int(st.st_mtime), 'duration': mi.get('duration'),
                         'status': mk.get('status', 'unreviewed'),
                         'nspans': sum(len(t.get('spans', [])) for t in mk.get('tracks', {}).values()),
                         'ndraw': len(mk.get('drawings', [])), 'note': mk.get('note', ''),
                         'nreview': sum(len(t.get('spans', [])) for t in (read_marks(rel, 'review') or {}).get('tracks', {}).values())})
        if vids:
            folders[os.path.relpath(dp, r)] = vids
    return [{'folder': k, 'videos': v} for k, v in sorted(folders.items(), key=lambda kv: (kv[0] != '.', kv[0].lower()))]

REVIEW_TRACKS = [   # the 'review' timeline: notes on a finished cut, left hand (N on a mark = its caption)
    {'key': 'Q', 'label': 'неверный фрагмент', 'color': '#ff4d4d', 'group': 'правки'},
    {'key': 'W', 'label': 'кадр / позиционирование', 'color': '#ff9f40', 'group': 'правки'},
    {'key': 'E', 'label': 'подписи / текст', 'color': '#ffd84d', 'group': 'правки'},
    {'key': 'R', 'label': 'звук', 'color': '#4dd2ff', 'group': 'правки'},
    {'key': 'A', 'label': 'урон / логика', 'color': '#b36bff', 'group': 'правки'},
    {'key': 'S', 'label': 'тайминг / монтаж', 'color': '#4d7dff', 'group': 'правки'},
    {'key': 'D', 'label': 'хорошо — оставить', 'color': '#4dff88', 'group': 'оценка'},
    {'key': 'F', 'label': 'другое', 'color': '#bbbbbb', 'group': 'оценка'}]
def get_config(tl=''):
    try: c = json.load(open(rdir('config' + ('@' + tl if tl else '') + '.json')))
    except Exception: c = {}
    c.setdefault('tracks', REVIEW_TRACKS if tl == 'review' else DEFAULT_TRACKS)
    return c

# ------------------------------------------------------------------ catalog: actresses + tags <-> videos, many-to-many
# catalog.json = {people: {id: {name, aliases[], avatar{rel,t,x,y,w,h}|null, note}},
#                 tags:   {id: {name, group}},
#                 videos: {rel: {people: [id], tags: [id]}}}
cat_lock = threading.Lock()
KINDS = ('people', 'tags')

def load_cat():
    try: c = json.load(open(rdir('catalog.json')))
    except Exception: c = {}
    c.setdefault('version', 1)
    for k in KINDS + ('videos',): c.setdefault(k, {})
    return c

def save_cat(c):
    atomic_json(rdir('catalog.json'), c)

def norm(s): return ' '.join(str(s).split()).lower()

def find_entry(c, kind, name):
    n = norm(name)
    for i, e in c[kind].items():
        if norm(e['name']) == n or any(norm(a) == n for a in e.get('aliases', [])): return i
    return None

def new_entry(c, kind, name, group=''):
    slug = re.sub(r'[^0-9a-zа-яё]+', '-', norm(name)).strip('-') or 'x'
    i, n = ('p_' if kind == 'people' else 't_') + slug, 2
    while i in c[kind]: i = f"{('p_' if kind == 'people' else 't_') + slug}-{n}"; n += 1
    c[kind][i] = {'name': ' '.join(name.split()), 'aliases': [], 'avatar': None, 'note': ''} if kind == 'people' else {'name': ' '.join(name.split()), 'group': group}
    return i

def resolve_entry(c, o):
    """op target: an existing id, or a name that is found (name or alias) or created; 'группа: имя' sets a tag group"""
    if o.get('id'):
        if o['id'] not in c[o['kind']]: raise ValueError('нет такой записи')
        return o['id']
    name, group = o['name'].strip(), o.get('group', '')
    if o['kind'] == 'tags' and ':' in name and not group: group, name = [x.strip() for x in name.split(':', 1)]
    if not name: raise ValueError('пустое имя')
    return find_entry(c, o['kind'], name) or new_entry(c, o['kind'], name, group)

def apply_ops(ops):
    with cat_lock:
        c = load_cat(); ids = []
        for o in ops:
            kind, op = o['kind'], o['op']
            if kind not in KINDS: raise ValueError('kind: people | tags')
            if op in ('assign', 'unassign', 'create'):
                i = resolve_entry(c, o); ids.append(i)
                for rel in o.get('rels', []):
                    safe_rel(rel); v = c['videos'].setdefault(rel, {}); lst = v.setdefault(kind, [])
                    if op == 'assign' and i not in lst: lst.append(i)
                    if op == 'unassign' and i in lst: lst.remove(i)
            elif op == 'update':
                e = c[kind][o['id']]; f = o['fields']
                if 'name' in f:
                    other = find_entry(c, kind, f['name'])
                    if other and other != o['id']: raise ValueError(f"«{f['name']}» уже есть — объедините записи")
                    e['name'] = ' '.join(f['name'].split())
                if 'aliases' in f: e['aliases'] = [' '.join(a.split()) for a in f['aliases'] if a.strip()]
                for k in ('group', 'note', 'avatar'):
                    if k in f: e[k] = f[k]
                ids.append(o['id'])
            elif op == 'merge':            # 'id' disappears into 'into': its videos, name (as an alias) and aliases move over
                a, b = o['id'], o['into']
                if a == b or a not in c[kind] or b not in c[kind]: raise ValueError('нечего объединять')
                ea, eb = c[kind].pop(a), c[kind][b]
                if kind == 'people':
                    eb['aliases'] = list(dict.fromkeys(eb.get('aliases', []) + [ea['name']] + ea.get('aliases', [])))
                    eb['avatar'] = eb.get('avatar') or ea.get('avatar')
                for v in c['videos'].values():
                    lst = v.get(kind, [])
                    if a in lst: lst[lst.index(a)] = b; v[kind] = list(dict.fromkeys(lst))
                ids.append(b)
            elif op == 'delete':
                c[kind].pop(o['id'], None)
                for v in c['videos'].values():
                    if o['id'] in v.get(kind, []): v[kind].remove(o['id'])
            else: raise ValueError('unknown op')
        c['videos'] = {r: v for r, v in c['videos'].items() if v.get('people') or v.get('tags')}
        save_cat(c)
        return c, ids

def make_avatar(pid, out):
    a = load_cat()['people'][pid]['avatar']
    info = probe(a['rel']); W, H = info['w'] or 1920, info['h'] or 1080
    x, y, w, h = (a.get(k, d) for k, d in (('x', 0), ('y', 0), ('w', 1), ('h', 1)))
    s = min(w * W, h * H); cx, cy = (x + w / 2) * W, (y + h / 2) * H     # square around the centre of the chosen region
    x0, y0 = max(0, min(W - s, cx - s / 2)), max(0, min(H - s, cy - s / 2))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f"{a['t']:.3f}", '-i', safe_rel(a['rel']), '-frames:v', '1',
                    '-vf', f'crop={int(s)}:{int(s)}:{int(x0)}:{int(y0)},scale=256:256', '-q:v', '3', out])
    return out

def avatar_file(pid):
    if not re.fullmatch(r'[\w-]{1,200}', pid): raise ValueError('invalid avatar id')
    e = load_cat()['people'].get(pid)
    if not e or not e.get('avatar'): return None
    out = rdir('avatars', pid + '_' + hashlib.sha1(json.dumps(e['avatar'], sort_keys=True).encode()).hexdigest()[:10] + '.jpg')
    if os.path.exists(out): return out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    return make_avatar(pid, out) if os.path.exists(safe_rel(e['avatar']['rel'])) else None

def _export_all():
    out = {'library': root(), 'exported': time.strftime('%Y-%m-%dT%H:%M:%S'), 'config': get_config(), 'catalog': load_cat(), 'videos': {}}
    base = rdir('marks')
    for dp, _, fns in os.walk(base):
        for fn in fns:
            if fn.endswith('.json'):
                rel = os.path.relpath(os.path.join(dp, fn), base)[:-5]
                try: out['videos'][rel] = json.load(open(confined(base, os.path.relpath(os.path.join(dp, fn), base))))
                except Exception: pass
    os.makedirs(rdir(), exist_ok=True)
    atomic_json(rdir('all.json'), out)
    return out

def export_all():
    with write_lock: return _export_all()

# ------------------------------------------------------------------ HTTP / WSGI
class HTTPError(Exception):
    def __init__(self, status, message): self.status, self.message = status, message

class Request:
    def __init__(self, environ, start_response):
        self.env, self.start_response = environ, start_response
        self.path = environ.get('PATH_INFO', '/') + '?' + environ.get('QUERY_STRING', '')
        self.headers = {k[5:].replace('_', '-').title(): v for k, v in environ.items() if k.startswith('HTTP_')}
        self.status, self.response_headers = 200, []

    def send_response(self, code): self.status = code
    def send_header(self, name, value): self.response_headers.append((name, value))
    def end_headers(self):
        self.response_headers.extend([
            ('X-Content-Type-Options', 'nosniff'), ('X-Frame-Options', 'DENY'),
            ('Referrer-Policy', 'same-origin'),
        ])
        self.start_response(f'{self.status} {HTTPStatus(self.status).phrase}', self.response_headers)

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b))); self.send_header('Cache-Control', 'no-store'); self.end_headers()
        return [b]

    def body(self):
        try: n = int(self.env.get('CONTENT_LENGTH') or 0)
        except ValueError: raise HTTPError(400, 'invalid content length')
        if n < 0 or n > MAX_BODY: raise HTTPError(413, 'request too large')
        if self.env.get('CONTENT_TYPE', '').split(';')[0].strip() != 'application/json':
            raise HTTPError(415, 'application/json required')
        value = json.loads(self.env['wsgi.input'].read(n) or b'{}')
        if not isinstance(value, dict): raise HTTPError(400, 'JSON object required')
        return value

    def send_file(self, path, ctype=None, cache=False):
        if not path or not os.path.isfile(path): return self.send_json({'error': 'not found'}, 404)
        size = os.path.getsize(path); ctype = ctype or mimetypes.guess_type(path)[0] or 'application/octet-stream'
        rng = self.headers.get('Range'); start, end = 0, size - 1
        if rng:
            m = re.fullmatch(r'bytes=(\d*)-(\d*)', rng)
            if not m or not any(m.groups()): return self.bad_range(size)
            if m.group(1): start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            else: start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end or start >= size: return self.bad_range(size)
            self.send_response(206); self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else: self.send_response(200)
        self.send_header('Content-Type', ctype); self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(max(0, end - start + 1)))
        self.send_header('Cache-Control', 'private, max-age=3600' if cache else 'private, no-cache'); self.end_headers()
        if self.env['REQUEST_METHOD'] == 'HEAD': return []
        def chunks():
            with open(path, 'rb') as f:
                f.seek(start); left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk: break
                    left -= len(chunk); yield chunk
        return chunks()

    def bad_range(self, size):
        self.send_header('Content-Range', f'bytes */{size}')
        return self.send_json({'error': 'invalid range'}, 416)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == '/' or u.path.startswith('/static/'):
                f = 'index.html' if u.path == '/' else u.path[len('/static/'):]
                return self.send_file(os.path.join(STATIC, os.path.basename(f)))
            if u.path == '/api/state': return self.send_json({'root': root(), 'recent': [] if ROOT_LOCKED else load_prefs().get('recent', []), 'root_locked': ROOT_LOCKED})
            if root() is None: return self.send_json({'error': 'no library'}, 400)
            if u.path == '/api/library': return self.send_json({'root': root(), 'folders': scan(), 'config': get_config(), 'catalog': load_cat()})
            if u.path == '/api/catalog': return self.send_json(load_cat())
            if u.path == '/api/avatar': return self.send_file(avatar_file(q['id']), 'image/jpeg', cache=True)
            if u.path == '/api/meta': return self.send_json(probe(q['rel']))
            if u.path == '/api/thumb': return self.send_file(cached('thumbs', q['rel'], make_thumb), 'image/jpeg', cache=True)
            if u.path == '/api/sprite': return self.send_file(cached('sprites', q['rel'], make_sprite), 'image/jpeg', cache=True)
            if u.path == '/api/marks': return self.send_json(read_marks(q['rel'], tl_ok(q.get('tl'))) or {})
            if u.path == '/api/config': return self.send_json(get_config(tl_ok(q.get('tl'))))
            if u.path == '/api/export': return self.send_json(export_all())
            if u.path == '/api/proxy':
                rel = q['rel']; st = 'done' if os.path.exists(proxy_path(rel)) else proxy_jobs.get(rel, 'none')
                return self.send_json({'status': st})
            if u.path == '/media':
                rel = q['rel']
                if q.get('proxy') == '1': return self.send_file(proxy_path(rel), 'video/mp4')
                p = safe_rel(rel); ext = os.path.splitext(p)[1].lower()
                ct = {'.mkv': 'video/webm', '.webm': 'video/webm', '.mov': 'video/mp4', '.m4v': 'video/mp4'}.get(ext)
                return self.send_file(p, ct)
            if u.path == '/drawing': return self.send_file(rdir('drawings', q['f']), 'image/png')
            return self.send_json({'error': 'unknown'}, 404)
        except ValueError as e: return self.send_json({'error': str(e)}, 400)
        except KeyError as e: return self.send_json({'error': f'missing {e}'}, 400)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == '/api/root':
                if ROOT_LOCKED: return self.send_json({'error': 'library is managed by the administrator'}, 403)
                p = os.path.realpath(os.path.expanduser(self.body()['path']))
                if not os.path.isdir(p): return self.send_json({'error': 'нет такой папки'}, 400)
                set_root(p); return self.send_json({'root': p})
            if root() is None: return self.send_json({'error': 'no library'}, 400)
            if u.path == '/api/marks':
                rel = q['rel']; safe_rel(rel); d = self.body(); tl = tl_ok(q.get('tl'))
                d['file'] = rel; d['path'] = safe_rel(rel); d['updated'] = time.strftime('%Y-%m-%dT%H:%M:%S')
                if tl: d['timeline'] = tl
                out = marks_path(rel, tl); os.makedirs(os.path.dirname(out), exist_ok=True)
                old = read_marks(rel, tl) or {}          # a page opened before a track was added (e.g. by an agent) must not drop it
                for K, tr in old.get('tracks', {}).items(): d.setdefault('tracks', {}).setdefault(K, tr)
                for k, v in old.items(): d.setdefault(k, v)
                atomic_json(out, d)
                export_all()
                return self.send_json({'ok': True})
            if u.path == '/api/catalog':
                c, ids = apply_ops(self.body()['ops'])
                export_all()
                return self.send_json({'catalog': c, 'ids': ids})
            if u.path == '/api/config':
                tl = tl_ok(q.get('tl')); new, old = self.body(), get_config(tl)      # a page with older code may not know a track's group: keep it
                for f in ('group', 'hot'):                  # ... or its hotkey
                    og = {t['key']: t.get(f) for t in old.get('tracks', []) if t.get(f)}
                    for t in new.get('tracks', []):
                        if not t.get(f) and t.get('key') in og: t[f] = og[t['key']]
                atomic_json(rdir('config' + ('@' + tl if tl else '') + '.json'), new)
                return self.send_json({'ok': True})
            if u.path == '/api/proxy':
                rel = q['rel']; safe_rel(rel)
                if not os.path.exists(proxy_path(rel)) and proxy_jobs.get(rel) not in ('queued', 'running'):
                    proxy_jobs[rel] = 'queued'; proxy_pool.submit(make_proxy, rel)
                return self.send_json({'status': proxy_jobs.get(rel, 'done')})
            if u.path == '/api/drawing':
                d = self.body(); rel = q['rel']; safe_rel(rel)
                name = os.path.join(rel, f"{d['t']:09.3f}.png"); out = rdir('drawings', name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                image = base64.b64decode(d['png'].split(',', 1)[1], validate=True)
                if not image.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('PNG required')
                atomic_bytes(out, image)
                return self.send_json({'file': name, 'abs': out})
            return self.send_json({'error': 'unknown'}, 404)
        except ValueError as e: return self.send_json({'error': str(e)}, 400)
        except KeyError as e: return self.send_json({'error': f'missing {e}'}, 400)


def set_root(p):
    global _meta
    state['root'] = p; _meta = None
    pr = load_prefs(); rec = [p] + [x for x in pr.get('recent', []) if x != p]; pr['recent'] = rec[:10]; save_prefs(pr)

def authorized(req):
    if AUTH_PASSWORD is None: return True
    try:
        scheme, token = req.headers.get('Authorization', '').split(' ', 1)
        if scheme.lower() != 'basic': return False
        user, password = base64.b64decode(token, validate=True).decode('utf-8').split(':', 1)
        return hmac.compare_digest(user.encode(), AUTH_USER.encode()) & hmac.compare_digest(password.encode(), AUTH_PASSWORD.encode())
    except (ValueError, UnicodeError): return False


def application(environ, start_response):
    req = Request(environ, start_response)
    method, path = environ['REQUEST_METHOD'], environ.get('PATH_INFO', '/')
    try:
        if path == '/healthz' and method in ('GET', 'HEAD'):
            ready = bool(root() and os.path.isdir(root()))
            return req.send_json({'status': 'ok' if ready else 'not_ready'}, 200 if ready else 503)
        if not authorized(req):
            req.send_header('WWW-Authenticate', 'Basic realm="review-deck", charset="UTF-8"')
            return req.send_json({'error': 'authentication required'}, 401)
        if method in ('GET', 'HEAD'):
            # Export writes persistent state and must be protected from cross-site requests too.
            if path == '/api/export' and req.headers.get('Sec-Fetch-Site') == 'cross-site':
                return req.send_json({'error': 'cross-site request refused'}, 403)
            return req.do_GET()
        if method == 'POST':
            if req.headers.get('Sec-Fetch-Site') == 'cross-site':
                return req.send_json({'error': 'cross-site request refused'}, 403)
            origin = req.headers.get('Origin')
            expected = PUBLIC_ORIGIN or (environ.get('wsgi.url_scheme', 'http') + '://' + req.headers.get('Host', ''))
            if origin and origin.rstrip('/') != expected:
                return req.send_json({'error': 'origin refused'}, 403)
            if environ.get('CONTENT_TYPE', '').split(';')[0].strip() != 'application/json':
                return req.send_json({'error': 'application/json required'}, 415)
            with write_lock: return req.do_POST()
        req.send_header('Allow', 'GET, HEAD, POST')
        return req.send_json({'error': 'method not allowed'}, 405)
    except HTTPError as e: return req.send_json({'error': e.message}, e.status)
    except FileNotFoundError: return req.send_json({'error': 'not found'}, 404)
    except (ValueError, KeyError, TypeError, IndexError) as e:
        return req.send_json({'error': 'invalid request'}, 400)
    except Exception:
        log.exception('Request failed: %s %s', method, path)
        return req.send_json({'error': 'internal server error'}, 500)


class LocalServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True

class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args): pass


def main(argv=None):
    global DATA_DIR, PREFS, ROOT_LOCKED, AUTH_USER, AUTH_PASSWORD, PUBLIC_ORIGIN
    parser = argparse.ArgumentParser(description='review-deck local and on-premises server')
    parser.add_argument('library', nargs='?', default=os.getenv('REVIEW_DECK_LIBRARY'))
    parser.add_argument('--host', default=os.getenv('REVIEW_DECK_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.getenv('REVIEW_DECK_PORT', '8765')))
    parser.add_argument('--on-prem', action='store_true', default=os.getenv('REVIEW_DECK_ON_PREM') == '1')
    parser.add_argument('--data-dir', default=os.getenv('REVIEW_DECK_DATA_DIR'))
    parser.add_argument('--password-file', default=os.getenv('REVIEW_DECK_PASSWORD_FILE'))
    parser.add_argument('--user', default=os.getenv('REVIEW_DECK_USER', 'review'))
    parser.add_argument('--public-origin', default=os.getenv('REVIEW_DECK_PUBLIC_ORIGIN'))
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    if args.on_prem and (not args.library or not args.data_dir or not args.password_file):
        parser.error('--on-prem requires library, --data-dir and --password-file')
    if args.host not in ('127.0.0.1', 'localhost', '::1') and not args.on_prem:
        parser.error('network binding requires --on-prem')
    if args.data_dir and not args.library: parser.error('--data-dir requires a fixed library')
    ROOT_LOCKED = args.on_prem or bool(args.data_dir)
    PUBLIC_ORIGIN = args.public_origin.rstrip('/') if args.public_origin else None
    if PUBLIC_ORIGIN:
        u = urllib.parse.urlparse(PUBLIC_ORIGIN)
        if u.scheme not in ('http', 'https') or not u.netloc or u.path or u.query or u.fragment or u.username:
            parser.error('--public-origin must be an http(s) origin without path')
    AUTH_USER = args.user
    if not AUTH_USER or ':' in AUTH_USER: parser.error('invalid user')
    if args.password_file:
        try:
            with open(args.password_file) as f: AUTH_PASSWORD = f.read().rstrip('\r\n')
        except OSError: parser.error('cannot read password file')
        if len(AUTH_PASSWORD) < 16: parser.error('password must contain at least 16 characters')
    if args.data_dir:
        DATA_DIR = os.path.realpath(os.path.expanduser(args.data_dir))
        os.makedirs(DATA_DIR, exist_ok=True)
        PREFS = os.path.join(DATA_DIR, 'preferences.json')
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool): parser.error(f'{tool} is required on PATH')
    if args.library:
        library = os.path.realpath(os.path.expanduser(args.library))
        if not os.path.isdir(library): parser.error('library directory does not exist')
        if DATA_DIR and os.path.commonpath((library, DATA_DIR)) in (library, DATA_DIR):
            parser.error('library and data-dir must be separate directories')
        if ROOT_LOCKED: state['root'] = library
        else: set_root(library)
    elif load_prefs().get('recent'):
        state['root'] = load_prefs()['recent'][0]
    # One process per data directory; JSON data must never be shared by replicas.
    data_lock = None
    if ROOT_LOCKED:
        try:
            data_lock = open(rdir('.server.lock'), 'a')
            fcntl.flock(data_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            atomic_json(rdir('.write-check.json'), {'ok': True})
            os.unlink(rdir('.write-check.json'))
        except (OSError, ValueError): parser.error('data directory is not writable or already in use')
    log.info('Listening on %s:%s (on-prem=%s)', args.host, args.port, args.on_prem)
    if args.on_prem:
        try: from waitress import serve
        except ImportError: parser.error('install requirements.txt to run the on-prem server')
        serve(application, host=args.host, port=args.port, threads=12, connection_limit=100,
              channel_timeout=60, max_request_body_size=MAX_BODY, max_request_header_size=32768,
              expose_tracebacks=False, clear_untrusted_proxy_headers=True)
    else:
        with make_server(args.host, args.port, application, server_class=LocalServer, handler_class=QuietHandler) as server:
            try: server.serve_forever()
            except KeyboardInterrupt: pass
    if data_lock: data_lock.close()

if __name__ == '__main__': main()
