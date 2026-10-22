# Validation — 23 October 2026

## Server mode

The following checks used temporary synthetic media and did not touch a personal library:

- Python 3.12 + Waitress 3.0.2: all 14 integration scenarios passed, including local mode without third-party Python packages. The 14 scenarios were repeated successfully after translating the interface and default track labels to English.
- Docker Compose, Linux ARM64: the image built and 13 integration scenarios passed; the container was healthy before and after restart. This run covers the initial on-premises implementation.
- The container ran as a non-root user with the source library mounted read-only.
- Chrome: HTTP Basic authentication, fixed library selection, playback/seeking, and persistence of a captioned mark passed without JavaScript errors.
- Python and JavaScript syntax checks passed.

The scenarios cover authentication for pages/API/media, path and symlink confinement, HTTP Range/HEAD, both timelines, configuration, catalog, drawings, export, ffmpeg metadata/previews/proxies, parallel writes, restart persistence, startup guards, request origin, and request-size limits.

## English interface and README screenshots

Four screenshots were captured from the running application using a separate temporary demo library with [LISA — SaWaDiKa](https://www.youtube.com/watch?v=FyS5dAywkEo) and [ILLIT — It’s Me](https://www.youtube.com/watch?v=bMhDJ0S0OBA). Participants, tags, statuses, and annotations are illustrative. The videos and temporary library data are not included in the repository.

The browser check verified all thumbnail images loaded, both source videos played and sought to the requested frames, the annotation/review timelines switched correctly, and the participant panel and keyboard help opened. All demo labels and annotations were checked for English text. Player controls fit the captured viewport; JavaScript and network error checks passed. The apostrophe in the second source filename is preserved and its preview loads correctly after URL escaping was fixed.

The screenshots were visually inspected, and every image link in README was checked against an existing PNG file. The former illustration was replaced.

![English annotations on the second video](screenshots/annotations-illit.png)

Target-server DNS, TLS certificates, reverse proxy, NAS permissions, backup/restore, and large-team load have not been verified. The app has not been deployed to the target server. See the [deployment guide](ON_PREMISES.md) for the supported operating model and its limits.
