# Changelog

All notable changes to the QC Tools additions are recorded here. Changes
inherited from upstream [PotreeDesktop](https://github.com/potree/PotreeDesktop)
are not.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-08-25

### Added

- **The imagery colouring now defaults to the imagery's own resolution**, with a
  **Memory** setting controlling the cell budget: native (64M cells), balanced
  (16M) or light (4M). A raster cell is one imagery pixel, and cells are three
  bytes rather than four, since a raster pre-filled with the no-imagery colour
  needs no covered-or-not flag. Measured at zoom 19: a 500 m survey samples at
  0.258 m for 11 MB, and a 1.1 km survey at 0.248 m for 61 MB where the old fixed
  eight million cell cap would have given 0.57 m. When a survey is too wide to
  cover at native resolution the panel now names the resolution it would have
  used, rather than quietly returning something blurrier than the imagery.
- **Colour the cloud from imagery**: a tenth tool. Samples the chosen basemap per
  point at each point's easting and northing and paints it onto the cloud, with a
  slider that shades the result by LiDAR intensity. These deliveries are
  intensity-only, and intensity cannot tell a road from a field from a roof;
  imagery cannot tell you anything about structure. Together they read as one
  picture. It also sidesteps Potree's opacity doing nothing while EDL is on,
  since a cloud carrying the ground imagery does not need to be seen through.
  - The imagery is resampled into a raster keyed by easting and northing rather
    than left in Web Mercator, so the per-point lookup is two subtractions and a
    divide instead of a proj4 transform on every node that streams in.
  - The reprojection between the two goes through a coarse interpolation grid,
    refined until its worst error against real proj4 is under a quarter of a
    cell. Measured on a 500 m UTM delivery: 0.008% of a cell.
  - The intensity shading splits its curve at the median rather than the midpoint
    of the range, so turning the slider up adds contrast without darkening the
    whole cloud.
  - No shader change and no sixth `potree.js` patch: it rides on Potree's own
    `rgba` attribute, which the renderer already binds to the shader's colour
    input. Every buffer handed to the renderer is stamped from an ever-increasing
    counter, because it re-uploads only when `attribute.version > vbo.version`
    and both sides start at zero when a cloud already has a colour attribute.
    Works on PotreeConverter 1.7 and 2.0 octrees alike.
  - Honest limit, stated in the panel and the docs: imagery is 2D, so canopy and
    the ground under it get the same colour. Excellent on ground and roads,
    unconvincing in vegetation.
- **Eleven more basemaps**, in four groups: Esri world imagery, topographic,
  street and hillshade; USGS imagery, topo and imagery-with-topo; Sentinel-2
  cloudless; OpenStreetMap, OpenTopoMap, Carto Positron and Dark Matter;
  Kartverket topo for Norway; and the existing custom XYZ slot. Every URL was
  fetched and every maximum zoom probed before it was added, rather than
  copied from documentation.
- **Overlay layers**: transparent tile sets drawn over the basemap. Esri
  boundaries and place names, Esri roads and transport, and OpenRailwayMap.
  Aerial imagery with place names on it reads far better than either alone, and a
  corridor delivery is easier to place against the railway layer than against
  roads. An overlay is cached and downloaded alongside its basemap, in its own
  tree, so local mode is not left showing a basemap with the overlay missing.

- **Attribute list colour-coding**: Potree's own Appearance ▸ Attribute dropdown
  is now marked up by where each entry comes from. Green for attributes really
  recorded in the point cloud, purple for the viewer's own colouring modes
  (`elevation`, `matcap`, `intensity gradient` and the rest), yellow and disabled
  for LAS attributes Potree could colour by that this cloud does not have. A
  legend under the dropdown counts each group, and the closed dropdown carries a
  stripe in the colour of the current choice.
  - The missing group is the point of it: stock Potree simply omits what is not
    there, so "this delivery has no RGB" and "RGB is in there and I have not
    scrolled to it" look identical.
  - Alias-aware, so a legacy point format's `scan angle rank` is recognised as
    `scan angle` and the converter's `rgb` as Potree's `rgba`. Extra-bytes
    attributes such as `Reflectance` are recognised as data.
  - No patch to `libs/potree/potree.js`: it hooks jQuery UI's `selectmenucreate`
    on the document, so it survives a Potree upgrade.
- **Fields the conversion dropped** are listed too, in orange: PotreeConverter
  never writes `scan direction flag`, `edge of flight line` or `scanner channel`,
  and packs the four class-flag bits into `classification flags`, so on a point
  data record format 6 delivery seven fields in the source LAS have no attribute
  of their own in the octree. A converted octree keeps no record of what it lost,
  so the source LAS public header is read back through `qc_source.json`, which
  File info already relies on. Absent, with the legend saying so, when there is no
  source file to read: an octree converted by another tool never gets a silent
  all-clear.
- **Scan angle in degrees**: selecting a scan angle puts the whole Extra
  Attribute control into degrees, caption, readout and slider travel alike.
  Point formats 6-10 store it as a signed int16 in 0.006 degree increments and
  Potree, having no LAS semantics, captioned it "Scalar range" and dragged in
  those raw units, where one degree is 167 slider units. Whole-degree precision
  belonged only to the legacy `scan angle rank` field of formats 0-5, which is
  the usual source of the confusion. The raw figures stay on screen underneath.
- `QCFileInfo.sourceRecord(pointcloud)`: the point data record format and
  extra-bytes dimension names of the file a loaded cloud came from.

- **Scan angle colouring**: a sixth tool. Colours the cloud by how far off nadir
  each point was measured, symmetrically, so that -35 and +35 degrees read alike,
  with a hard step at a chosen field of view. Set the limit to the scanner's real
  FOV and the red shows what a narrower acceptance would discard. Colours only:
  red points stay visible and still count in the probe and the density colouring.
  - Potree cannot do this with its own controls, because `getExtra()` clamps the
    gradient coordinate before the texture lookup and the Gradient panel's
    "Mirrored Repeat" has nothing to act on. Setting the display range to plus or
    minus max|angle| puts nadir on the middle of the gradient, and the gradient
    itself is built as a mirror about that midpoint, which needs no shader change.

### Fixed

- **Rectangles of far-too-small points are gone.** A seventh `potree.js` patch,
  and the fix for a long-standing "some squares look sparse, as if they never
  loaded" complaint. PotreeConverter can write hierarchy entries whose data is
  zero bytes. They draw nothing, but they still occupy a texel in the visibility
  texture the adaptive point size shader walks, and they still set their bit in
  their parent's child mask, so `getLOD()` descends into them and stops. Having
  no points they have no density, so their LOD offset falls to a flat 0 where a
  populated sibling reports -1.5: measured on one delivery, siblings at level 4
  resolve to LOD 2.5 with points and 4.0 without, which draws every point of the
  parent inside that cube about 2.8x too small. Raising min node size only hid it
  by pruning the empty nodes out of the visible set, and raising the point budget
  could never help, because an empty node costs no budget. Empty nodes are now
  left out of the texture, so the walk stops at the parent the points came from.
- **The viewer no longer dies with "Potree Encountered An Error" at a large point
  budget.** A sixth `potree.js` patch. Adaptive point size takes each point's size
  from the depth of the deepest visible node covering it, and the shader reads
  that tree out of a 2048 x 1 texture holding exactly 2048 nodes.
  `computeVisibilityTextureData` built four bytes per visible node with no limit,
  so past 2048 nodes the copy into that fixed image threw `RangeError: offset is
  out of bounds` from inside the render loop and Potree replaced the viewer with
  its error page. Measured on an 84M point delivery at min node size 0: 1,735
  visible nodes at a 10M budget renders, 2,049 at a 30M budget dies. Visible
  nodes are now capped, degrading the way the point budget already does. Both
  defaults here push towards the limit, since `index.html` sets
  `setMinNodeSize(0)` and `desktop.js` sets the material to `ADAPTIVE`.
- **The overlay opacity control is no longer off the edge of the sidebar.** A
  flex item defaults to `min-width: auto`, so the overlay `<select>` refused to
  shrink below its longest option name and pushed the opacity box past the
  300 px sidebar, where it could not be clicked.

- **A compound coordinate system no longer stops a cloud rendering.** Real
  surveys declare horizontal plus vertical as `COMPD_CS[..., PROJCS[...],
  VERT_CS[...]]`, which proj4 cannot parse and does not fail politely about: it
  throws the entire WKT string, unwrapped and without a stack. Potree calls proj4
  from its render path, so the cloud loaded and then drew nothing. The horizontal
  half is now lifted out, and any coordinate system is tested by building a
  transform and pushing a point through it before it is handed to Potree.
- The Appearance attribute dropdown no longer hangs off the bottom of the window
  when the list is long. jQuery UI opens a selectmenu with `collision: "none"`;
  it now uses `flipfit` and has a maximum height so a long list scrolls. Stock
  Potree already reached the bottom edge on a 1100 px window with a cloud
  carrying a couple of extra attributes.
- Disabled entries in that dropdown are no longer washed out. jQuery UI's theme
  puts `opacity: .35` on them, which faded the group colour along with the text.
- **Colouring by scan angle, user data, classification flags or any extra-bytes
  attribute of 4 bytes or fewer now works.** A fifth `potree.js` patch. Potree's
  decoder rescales an attribute into 0..1 only when its type is wider than 4
  bytes, but the renderer computed the shader's scale and offset as though every
  attribute were rescaled. The shader therefore evaluated `clamp(rawValue, 0, 1)`,
  so the whole cloud came out in exactly two flat colours split at the value 1,
  and the Extra Attribute range slider appeared to do nothing however far it was
  dragged. `gps-time` was never affected, because a double is 8 bytes; that is
  why one attribute looked right and the rest did not.

## [1.1.0] - 2026-08-14

### Added

- **File info**: a fifth tool. One button reports everything the loaded files
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
- **Show coverage in Google Earth**: writes the cloud's real plan-view coverage
  as KML and opens it in Google Earth Pro. Separate blocks come out as separate
  areas in one `MultiGeometry`; a lake or a gap in the returns comes out as a
  hole (`innerBoundaryIs`). Disabled, with the reason given, when the files
  record no coordinate system.
- **Source file recording**: the converter panel now writes `qc_source.json`
  beside a converted octree naming the LAS/LAZ it came from. PotreeConverter
  keeps neither the source path nor the coordinate system, so without this a
  converted cloud can never report its own LAS header or CRS.
- `package-lock.json` is now committed, so `npm install` resolves the same
  dependency tree on every machine.
- `CHANGELOG.md` and `CONTRIBUTING.md`.

### Fixed

- The report window no longer carries Electron's stock File/Edit/View/Window/Help
  menu. Its **View ▸ Reload** reloaded `about:blank`, so the report vanished and the
  window was left dead, because the document is written in rather than loaded
  from a URL.
- A `qc_source.json` carrying a byte order mark no longer makes the whole source
  section disappear without a word.

### Changed

- Coverage and average density are measured from **real point positions** read out
  of `octree.bin`, not from octree node cubes. Potree's coarse levels are a thinned
  copy of the whole cloud, so three or four levels, well under a million points,
  cover it completely. Measured against synthetic clouds of known footprint, the
  error fell from 33% to 1.5%, and holes are found at all, which the node-cube
  version could not do. Brotli-encoded octrees and COPC files fall back to the
  coarse mask and the report says so.

## [1.0.0] - 2026-08-11

First release, on top of upstream PotreeDesktop `5435c22`.

### Added

- **Point density probe**: drop an N × N m square on the cloud and count every
  point in the column beneath it.
- **Box clip**: six walls on three two-handle sliders, applied on the GPU.
- **Polygon cut**: draw a shape and keep what is inside it, extruded straight
  down, without moving the camera.
- **Density colouring**: colour the whole cloud by points/m² against a spec,
  with a live threshold slider.
- Four fixes to the bundled `libs/potree/potree.js`, each marked `[QC Tools]`.
  They are upstream defects rather than anything specific to these tools; the
  `worker.onerror` one can freeze any Potree session. See
  [`src/QC_TOOLS.md`](src/QC_TOOLS.md#potree-patches).

[1.2.0]: https://github.com/TheseDamnComputers/PotreeDesktop-QC-Tools/releases/tag/v1.2.0
[1.1.0]: https://github.com/TheseDamnComputers/PotreeDesktop-QC-Tools/releases/tag/v1.1.0
[1.0.0]: https://github.com/TheseDamnComputers/PotreeDesktop-QC-Tools/releases/tag/v1.0.0
