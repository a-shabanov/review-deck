# review-deck

Local tool for reviewing video sources: library with previews, defect flags, and real-time marking of time spans with keys.
The result is plain JSON that an agent can read.

```
python3 ~/Projects/review-deck/server.py [/path/to/library]     # then open http://127.0.0.1:8765
```

## On-premises deployment

Run one shared instance on your own server with Docker Compose, password authentication,
read-only source media and a separate persistent data directory. See
[the deployment, HTTPS, migration and backup guide](docs/ON_PREMISES.md).
There are no cloud services or CDN dependencies at runtime. Network mode uses Waitress;
the original localhost workflow below remains available without Python dependencies.

```sh
cp .env.example .env
# Set library/data paths and create secrets/review-password.txt as described in the guide.
docker compose up -d --build
```

The library folder can also be changed in the app (field at the top). Sub-folders become sections.
Folders starting with `_` or `.` are skipped.

## Where the results go

`<library>/_review/`:
- `marks/<relative path>.json` — one file per video
- `all.json` — every video merged; rewritten on every save and by «Экспорт JSON»
- `drawings/<relative path>/<seconds>.png` — annotated still frames (frame + drawing)
- `config.json` — key → track label / colour
- `catalog.json` — actresses and tags and which videos they are on (many-to-many); also copied into `all.json`
- `avatars/` — actress avatar crops (cache)
- `thumbs/`, `sprites/`, `proxy/`, `meta.json` — caches, safe to delete

Per-video JSON:
```json
{
  "file": "Kazumi/scene.mp4", "path": "/abs/path/scene.mp4",
  "status": "unreviewed | ok | defect", "note": "",
  "duration": 930.7, "fps": 30.0, "w": 1920, "h": 1080,
  "tracks": { "F": { "label": "action", "color": "#ff4d6d", "spans": [[12.4, 18.9], [40.0, 40.0]] } },
  "drawings": [ { "t": 4.96, "png": "/abs/.../00004.960.png", "strokes": [ { "c": "#ff3b30", "w": 6, "pts": [[0.43, 0.45]] } ] } ],
  "updated": "2026-10-17T15:40:00"
}
```
Spans are seconds in the source file. `[t, t]` is a point (a quick tap). Stroke points are normalised 0..1 of the frame.

Catalog (`catalog.json`):
```json
{
  "people": { "p_kazumi": { "name": "Kazumi", "aliases": ["Kazumi Squirts"], "note": "",
                            "avatar": { "rel": "scene.mp4", "t": 200.0, "x": 0.3, "y": 0.1, "w": 0.4, "h": 0.4 } } },
  "tags":   { "t_dp": { "name": "DP", "group": "сцена" } },
  "videos": { "scene.mp4": { "people": ["p_kazumi"], "tags": ["t_dp"] } }
}
```
Ids never change, so renaming keeps every link. Videos are keyed by their path relative to the library: files stay where they are.
API: `POST /api/catalog {"ops": [...]}` with `assign` / `unassign` (`kind`, `id` or `name`, `rels`), `update` (`fields`: name,
aliases, group, note, avatar), `merge` (`id` → `into`; the old name becomes an alias), `delete`. A new name in `assign` creates the entry;
`"студия: Blacked"` creates a tag in group «студия».

Short ids: if `_review/ids.json` (`{"file.mp4": "s01"}`) exists, each card shows its id as a badge, the player title starts
with it, and the search box finds a video by it. The asian project writes it with `_story/tools/ids_to_review.py`.

## Keys

Library: arrows select (Shift extends) · ⌘/Shift-click select several · ⌘A all · Space quick preview (← → seek, ↑ ↓ speed) ·
A actresses · T tags (for all selected) · G group by folders / actresses / tags / none (one flat list) · X defect · O ok · U clear · Enter open · hover = scrub.
Sidebar: click an actress or tag to filter, ⌘-click to combine (AND). A video with two actresses shows up in both groups.
«Справочник»: rename, aliases, tag groups, merge duplicates, delete.

Track keys are letters plus `;` `'` `/` and the backquote key (matched by physical key, so they work on the Russian layout too: ж э . ё).
A track's id (its key in the marks files) and the key that marks it can differ: `hot` in `config.json` is a letter, a digit,
a punctuation key or `alt+X` (avoid the Option layer for tracks: a track key is held while Space is pressed, and ⌥Space opens Spotlight). Settings show both: code, then key. Changing `hot` never touches
existing marks.
Player: Shift-drag on the timeline selects marks with a rubber band, Cmd-click adds/removes one, a click on a track's name
selects its marks in view (Shift: whole file), Cmd+A all marks in view; Del deletes the selection (one undo step),
dragging a selected mark moves the whole selection, Alt+Shift+arrows nudge it, Esc clears it.
Player: N on a selected mark gives it a caption (stored as a third element: `[start, end, "text"]`); captions show on the
timeline and over the video while the mark is under the playhead.
Player: I opens actresses/tags of the current video; 📷 next to an actress takes her avatar from the current frame
(zoom in on the face first — the visible part of the frame is used).

Player: see `?` in the app. Hold a track key to record a span; Shift+key latches start/end.
Left hand (right one on the mouse): Space play/pause · Tab back 2 s (Shift 10 s) · ` forward 2 s (Shift 10 s) ·
⌥3 / ⌥4 slower / faster, ⌥5 = 1× · ⌥Z / ⌥C frame step · ⌥X delete selected marks · ⌥R reverse · ⌥Tab / ⌥⇧Tab next / previous video.
Right hand, as before: J / K / L shuttle (reverse / stop / forward, repeat = faster) · ↑ ↓ speed steps · 6–9 speed presets, 0 = 1× ·
← → 2 s (Shift 10 s, ⌘ 60 s, ⌥ one frame) · , . frame step · PgUp/PgDn previous/next mark ·
= - \ zoom · wheel zoom to cursor, drag to pan · P draw on the still frame (Enter saves) · Shift+P proxy · ⌘Z undo · Esc back.

Reverse playback seeks frame by frame; on long-GOP files it is choppy — Shift+P builds an all-intra 540p proxy
that makes reverse and frame stepping smooth (also used automatically for files the browser cannot play).
