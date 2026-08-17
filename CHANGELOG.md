# Changelog

All notable changes to the QC Tools additions are recorded here. Changes
inherited from upstream [PotreeDesktop](https://github.com/potree/PotreeDesktop)
are not.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-08-14

### Added

- **File info** — a fifth tool. One button reports everything the loaded files
  record, in a separate window of collapsible cards you can select and copy from:
  - LAS/LAZ/COPC public header field by field, with the global encoding decoded
    bit by bit and the point count broken down by return
  - every VLR and EVLR in a table, with the well-known records decoded: OGC WKT
    (plus the EPSG code and name of the horizontal system), GeoTIFF geokeys,
    extra-bytes descriptors, the COPC info block, the LASzip marker
  - a compression card for LAZ files: ratio, uncompressed size, data saving
  - the whole Potree `metadata.json`, every stored attribute with its type and
    range, and the classification histogram as classes-present with shares
  - average points/m², both from the bounding box and from measured coverage
  - built on the `copc.js` already bundled for Potree's COPC support, so no new
    dependency
- **Show coverage in Google Earth** — writes the cloud's real plan-view coverage
  as KML and opens it in Google Earth Pro. Separate blocks come out as separate
  areas in one `MultiGeometry`; a lake or a gap in the returns comes out as a
  hole (`innerBoundaryIs`). Disabled, with the reason given, when the files
  record no coordinate system.
- **Source file recording** — the converter panel now writes `qc_source.json`
  beside a converted octree naming the LAS/LAZ it came from. PotreeConverter
  keeps neither the source path nor the coordinate system, so without this a
  converted cloud can never report its own LAS header or CRS.
- `package-lock.json` is now committed, so `npm install` resolves the same
  dependency tree on every machine.
- `CHANGELOG.md` and `CONTRIBUTING.md`.

### Fixed

- The report window no longer carries Electron's stock File/Edit/View/Window/Help
  menu. Its **View ▸ Reload** reloaded `about:blank` — the report vanished and the
  window was left dead — because the document is written in rather than loaded
  from a URL.
- A `qc_source.json` carrying a byte order mark no longer makes the whole source
  section disappear without a word.

### Changed

- Coverage and average density are measured from **real point positions** read out
  of `octree.bin`, not from octree node cubes. Potree's coarse levels are a thinned
  copy of the whole cloud, so three or four levels — well under a million points —
  cover it completely. Measured against synthetic clouds of known footprint, the
  error fell from 33% to 1.5%, and holes are found at all, which the node-cube
  version could not do. Brotli-encoded octrees and COPC files fall back to the
  coarse mask and the report says so.

## [1.0.0] — 2026-08-11

First release, on top of upstream PotreeDesktop `5435c22`.

### Added

- **Point density probe** — drop an N × N m square on the cloud and count every
  point in the column beneath it.
- **Box clip** — six walls on three two-handle sliders, applied on the GPU.
- **Polygon cut** — draw a shape and keep what is inside it, extruded straight
  down, without moving the camera.
- **Density colouring** — colour the whole cloud by points/m² against a spec,
  with a live threshold slider.
- Four fixes to the bundled `libs/potree/potree.js`, each marked `[QC Tools]`.
  They are upstream defects rather than anything specific to these tools; the
  `worker.onerror` one can freeze any Potree session. See
  [`src/QC_TOOLS.md`](src/QC_TOOLS.md#potree-patches).

[1.1.0]: https://github.com/TheseDamnComputers/PotreeDesktop-QC-Tools/releases/tag/v1.1.0
[1.0.0]: https://github.com/TheseDamnComputers/PotreeDesktop-QC-Tools/releases/tag/v1.0.0
