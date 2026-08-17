# QC Tools

Additions to PotreeDesktop for point cloud quality checking: measure local point
density, isolate a region, colour the whole cloud against a density spec, and
report everything the loaded files record.

Everything lives in a **QC Tools** section in the sidebar.

## Files

| File | What it is |
| --- | --- |
| `src/qc_tools.js` | The four viewer tools |
| `src/qc_fileinfo.js` | The file info report |
| `src/qc_tools.css` | Panel styling |
| `index.html` | Four lines: the stylesheet, the two scripts, and `QCTools.install(viewer)` inside `viewer.loadGUI()` |
| `src/desktop.js` | Two additions marked `[QC Tools]` — see [File info](#5-file-info) |
| `main.js` | One addition marked `[QC Tools]`: strips the stock menu off the report window |
| `libs/potree/potree.js` | Four small patches, each marked `[QC Tools]` — see [Potree patches](#potree-patches) |

Launch with the `Potree QC Viewer` shortcut in the project folder, or:

```bash
npm start
```

## 1. Point density probe

Drop an N x N m square on the cloud — the footprint as seen from above — and
count every point in the vertical column through it.

- The toolbar button (area icon, end of the Tools row) or **Place square** arms
  the pick. Click a spot on the cloud; right-click or Esc cancels.
- **Square size** defaults to 1.0 m, so the count *is* the points/m² figure. Any
  size works — the panel always divides by the real area.
- The result shows total points, points/m², and the z range the points span. The
  density is also drawn as a label on the orange marker box, which shrinks to the
  measured z extent once counting finishes.
- Probes appear in Scene ▸ Objects and can be deleted there or from the panel.

Counting walks the octree to full depth, so the number is the true stored point
count, not the count at the current level of detail. **Cancel** stops it and
reports the partial count.

The column is unbounded vertically — on a cloud with ground and canopy,
everything above the square is included unless a cut or filter excludes it.

### It counts only what you can see

The probe applies the same tests Potree's shader uses to decide whether a point
is drawn: GPS time, return number, number of returns, point source id,
classification visibility, and the box and polygon cuts. Slide the GPS Time
filter to a single collection pass and the probe reports that pass's density.

When a filter removed something, the result also shows the unfiltered figure and
names the filters applied. Filters are snapshotted when the probe is placed, so
moving sliders afterwards does not silently rewrite an existing result.

Deliberately *not* applied: level of detail and the point budget. Those change
with camera distance, and a density that moved when you zoomed would be useless.

## 2. Box clip

Six walls — X, Y and Z min/max — as three two-handle sliders. Everything outside
is hidden on the GPU, so it is instant on large clouds and nothing is deleted.

- **Isolate a box** creates the clip volume.
- **Zoom sliders to box** re-bases the slider range onto the current box, so the
  full travel and full precision go on the region you kept. Repeat to keep
  narrowing. **Reset to full cloud** restores the original range.
- **Zoom view** flies the camera to the box.

Slider range comes from the cloud's bounding box. PotreeConverter 2.0 stores a
*cubic* bounding box, so on a wide flat cloud the Z slider starts out covering a
lot of empty air — one press of **Zoom sliders to box** fixes that.

The box outline and the density probes are excluded from mouse picking, so you
can orbit and pan straight through them. As a consequence they cannot be dragged
with the transformation gizmo; the sliders are the only way to move them.

## 3. Polygon cut (top-down)

Draw a shape around something and keep only what falls inside it, extruded
straight down the z axis.

- **Draw polygon**, or the polygon icon in the Clipping toolbar. **Your view is
  not moved** — stay zoomed in on whatever you are looking at.
- Click each corner. **Double-click or right-click** closes the shape, Esc
  cancels. Three corners minimum, eight maximum (a hard limit in Potree's clip
  shader).
- Navigation stays live while drawing. A click that moved more than a few pixels
  counts as a drag, not a corner.
- Corners land on the cloud where you click. Clicking past the cloud drops the
  corner onto a horizontal plane at the previous corner's height, so you can draw
  *around* an object rather than only across it.
- Only the x/y of each corner is used, so corners at different heights are fine.
- Cuts stack — draw a second polygon to narrow further.

Potree's own polygon clip freezes the camera and extrudes along *that* view
direction, which under a perspective camera is a diverging frustum rather than a
vertical column, and it disables navigation while drawing. This version picks
corners in 3D from your actual view, then builds the clip volume against a
synthetic top-down orthographic camera that is never shown.

## 4. Density colouring

Colour the cloud by local point density so a delivery can be checked against a
spec like "50 ppsm", with everything below the threshold forced to red.

- Set **Cell** (default 1 m, so the numbers are literally points per square
  metre) and press **Analyse density**.
- Drag **Red below** to set the spec. Solid red under the limit, orange at it,
  ramping through yellow to green at twice it. The hard step at the limit is
  deliberate: a cell one point under spec should read as a failure, not as
  "nearly fine".
- The slider recolours live — it only changes the gradient and display range, so
  no re-analysis is needed. The grid holds real pts/m² values.
- **Restore colours** puts the previous attribute and gradient back and keeps the
  analysis, so you can toggle between them.

Density is counted per square grid cell over the **full-resolution** data, which
is what survey specs mean by points per square metre. It applies the same
visibility rules as the probe, so cutting to one collection pass and re-analysing
gives that pass's density. Cells only partly inside a cut come out low, because
the points outside really were removed — so the boundary cells of a cut are not
meaningful figures.

### Speed

The scan reads every point once, streaming through Potree's own
`getPointsInProfile` in up to 24 parallel strips. Measured on a 2.25M point
cloud, 1 m cells, local disk:

| Run | Time |
| --- | --- |
| Whole cloud | ~6 s |
| Clipped to roughly a third | ~1 s |
| 10 x 10 m polygon cut | 0.3 s |

Roughly 370k points/second, so a whole-cloud pass over an 80M point delivery is
minutes. **Clip to the area you care about first** — that is exact, not an
approximation, and it is the difference between 0.3 s and 6 s. The grid is sized
to the cut too: a 10 x 10 m polygon on a 100 x 100 m cloud drops it from 10,201
cells to 182.

Press **Stop** and it discards the partial grid rather than showing an undercount.

### Colouring nodes as they stream in

A node that arrives without a density value reads as zero and paints **red**, so
the colouring has to keep pace with loading or green ground flashes red while you
zoom. The update hook runs every frame with a 6 ms time budget rather than a
fixed node count. Colouring a node is only a grid lookup per point, so it keeps
up: measured over sixteen camera moves across a 30M point cloud, the fraction of
visible nodes still uncoloured was 0.

This was worth a fixed node cap only while colouring a node also meant tearing
down its GPU buffer. It does not any more, so the cap was far too tight.

### Scripting

```js
QCTools.density.probeAt(x, y, z);              // place a probe, world coords
QCTools.polygon.cutFromPoints([[x,y,z], ...]); // cut without clicking
QCTools.densityColor.densityAt(x, y);          // pts/m² at a world position
QCTools.densityColor.grid;                     // the raw grid
```

## 5. File info

One button — **Point cloud info**, or the LAS icon at the end of the Tools row —
opens a separate window holding everything the loaded files record, laid out as
collapsible cards in two columns.

Nothing in the page is a script and nothing in it is a button except the one in
the toolbar: select with the mouse or Ctrl+A, copy with Ctrl+C, and what lands on
the clipboard is what is on screen. The toolbar is `user-select: none`, so a
select-all skips it and the copy is report only. It has to be a separate window
rather than a panel, because `potree.css` sets `user-select: none` on the sidebar
and the render area.

Every loaded cloud is reported, one group of cards each. Nothing is read from
what is drawn, so clips, filters and the point budget change none of it.

The report is built once as a document of sections and rows, then rendered twice
— as HTML for the window and as plain text for `QCTools.fileInfo.report()` and
the in-page fallback. One source, so the two cannot drift.

### The window has no menu

Electron gives a `window.open` popup its stock File/Edit/View/Window/Help menu.
That menu is wrong here and one item in it is actively destructive: the report's
document is written in with `document.write` and has no URL of its own, so
**View ▸ Reload reloads `about:blank`** — the report vanishes and the window is
left dead. `main.js` strips the menu in a `did-create-window` handler.

Ctrl+A and Ctrl+C need no menu: Chromium handles both itself on Windows.

### Two columns, packed rather than gridded

A CSS grid lays cards out in rows, so a two-row card beside a thirty-row card
leaves twenty-eight rows of hole — which is exactly what the first version did.
Multi-column layout flows around that but splits any card taller than the column.

So the cards are packed: tallest first into whichever column is currently
shorter, then each column is rendered back in document order, so reading a column
top to bottom still follows the report. A card marked wide — the big tables, the
WKT, the density prose — closes the pair and spans both.

Two cards were also split up, because no packing can balance a card taller than
everything beside it: the potree metadata into *potree octree* / *files on disk* /
*octree extent*, and the LAS header into *las header* / *point records* /
*las extent*. Measured worst-case imbalance after that is 17% of a column's
height, against 28 rows of hole before.

### What it reports

**Potree octree** — the whole of `metadata.json`: version, point count, encoding,
root spacing, hierarchy depth and step size, position scale and offset, the
cubic bounding box *and* the tight extent from the position attribute's range,
the size of all three files on disk, a table of every stored attribute with its
type and min/max, and the classification histogram as a table of classes present
with counts and percentages.

**LAS / LAZ / COPC** — the full public header field by field, including the
generating software and system identifier; the global encoding as a value plus a
named True/False for each of its bits; the point data record format spelled out;
the point count broken down by return; scale, offset, min, max and extent as an
X/Y/Z table; and for a LAZ file a **compression** card with the ratio, the
uncompressed size and the data saving. Then every VLR and EVLR in a table, with
the well-known records decoded rather than listed:

| Record | Decoded as |
| --- | --- |
| `LASF_Projection` 2112 | the OGC WKT in full, plus the EPSG code and name of the horizontal system |
| `LASF_Projection` 34735/34736/34737 | the GeoTIFF keys as a table, with the projected and vertical EPSG codes pulled out |
| `LASF_Spec` 4 | the extra bytes descriptors |
| `LASF_Spec` 3 | the text area description |
| `laszip encoded` 22204 | noted as LASzip compression |
| `copc` 1 | the COPC info block: cube, root spacing, hierarchy page, GPS time range |

This uses the `copc.js` build already bundled at `libs/copc/index.js` for
Potree's own COPC support — `Las.Header`, `Las.Vlr` and `Copc.create` — so there
is no new dependency. Its own file getter is a stub in that browser build, so the
report supplies a `fs`-backed one.

`Las.Header.parse` accepts LAS 1.2 and 1.4 only. An older revision reports the
reason rather than a stack trace.

### Getting the LAS header for a converted cloud

PotreeConverter keeps neither the source path nor the coordinate system: on a real
delivery `metadata.json` has `projection: ""` while the source LAZ carried a full
WKT. So the converter panel now writes `qc_source.json` next to the octree
recording what went in, and the report reads the source file's header back. Two
additions in `src/desktop.js`, both marked `[QC Tools]`:

- `writeSourceManifest()`, called from both converters
- `loadDroppedPointcloud()` sets `pcoGeometry.url` for a dropped `.copc.laz`,
  which `CopcLoader` does not — it keeps only its range getter, so the path the
  cloud came from is otherwise lost

An octree converted before this existed has no manifest, and the report simply
says nothing about a source file.

### The coverage mask

One raster underpins both the average density and the KML outline: a plan-view
mask of where the cloud actually has points.

It is built by reading **real point positions** out of `octree.bin` — but only a
few hundred thousand of them. Potree's coarse octree levels are not a coarse
*region*; each one is a thinned copy of the **entire** cloud at a spacing that
halves every level. So reading levels 0..k gives complete coverage at
`spacing / 2ᵏ`, and three or four levels is enough to fill a mask 256 cells
across. On a 30M point cloud that is 374,510 points in 32 nodes — 1.2% of the
file, about 40 ms.

Both files are read off disk rather than through the live octree, so asking for a
report cannot perturb Potree's loader.

Details that had to be right:

- **Cell size is at least three point spacings.** A thinned point set leaves the
  odd covered cell empty by chance; at three spacings a covered cell holds ~9
  points, so that is rare. A **morphological close** then removes what is left.
  A false gap in a coverage report is worse than a missing one.
- **Records inside a hierarchy chunk are read in full even where the node does
  not matter.** They are ordered by the queue that consumes them; skipping one
  shifts every record after it onto the wrong node.
- **Perimeter cells are clipped to the tight extent** when the area is summed.
  Without that the occupied area came out *larger* than the bounding box on a
  cloud that fills its rectangle.

#### Why not node cubes

The first version used the octree hierarchy alone: mark the cube of every
childless node. No point data, very fast, and **wrong in a way that matters**. A
node exists only where there are points, but a *childless* node can be coarse —
at a sparse fringe, 40 m across — and marking its whole cube both inflates the
area and fills in gaps. On the annulus test cloud it read 44,797 m² against a
true 30,188 m², and it filled the hole in completely.

It survives as the fallback for a brotli-encoded octree or a COPC file, whose
point data cannot be read straight off the disk. The report names which mask it
used, and warns when it is the coarse one.

#### The two figures

**Bounding-box footprint** divides the point count by the tight rectangle.
**Occupied footprint** divides it by the mask.

The bounding-box figure collapses whenever the cloud does not fill its rectangle
— a corridor, a diagonal strip, anything with a lake in it. The occupied figure
is the one to read. Both are whole-cloud averages, accurate to about a cell
around the edges; a delivery is judged per cell, which is what the density probe
and density colouring are for.

### Show coverage in Google Earth

The button in the report's toolbar writes the cloud's coverage to a KML and opens
it in Google Earth, so you can see where the data was physically captured. It is
disabled, and says why, when the files record no coordinate system.

It is the **real coverage, not the bounding box**. The [coverage
mask](#the-coverage-mask) is traced into closed rings along cell edges, so:

- a cloud in two blocks comes out as two areas, in one `MultiGeometry` so it
  stays a single placemark you can switch on and off as one thing
- a lake, or any gap in the returns bigger than a cell, comes out as a hole —
  a KML `innerBoundaryIs` ring, which Google Earth renders as a hole

How the tracing works:

- **Boundary edges are oriented with the occupied cell on the left.** That makes
  outer rings come out counter-clockwise and holes clockwise, so they are told
  apart by the sign of their area — no containment test needed for that part.
  Holes are then assigned to the smallest outer ring that contains them, using a
  sample point a quarter-cell into the hole rather than a vertex on its boundary.
- **Two cells touching only at a corner** leave that lattice point with two ways
  out. Taking the sharpest right turn treats the cells as four-connected, which
  keeps the two regions as separate rings instead of joining them through a
  zero-width neck.
- **Rings are simplified to about one cell** (collinear points dropped, then
  Douglas–Peucker, iterative so a long ring cannot run the stack out). That turns
  the staircase a cell mask necessarily produces into the rough outline it stands
  in for, and it is the same tolerance the report claims for accuracy. Vertices
  are capped; past the cap the tolerance doubles and it tries again.
- **Vertices are clamped to the tight extent**, since a cell can overhang the
  last point in it but the cloud cannot reach past its own bounding box.

When only the coarse node-cube mask is available the outline is still traced, but
the report says so and warns that a gap smaller than a coarse node may be filled
in rather than shown.

Each placemark's description carries the point count, the bounding box, the cell
size, the number of areas and holes, the coordinate system and the centre.

Getting a transform out of what LAS files actually contain took two fallbacks:

- proj4 parses a WKT1 `PROJCS[...]` node, but **not** the `COMPD_CS[...]` that
  wraps it whenever the file also declares a vertical system — which is the common
  case. So the PROJCS node is extracted and handed over on its own.
- `proj4("EPSG:32610")` throws. proj4 ships almost no EPSG definitions, so a
  GeoTIFF-keyed file with no WKT has only a code. UTM zones are built from the
  code directly (`326xx` north, `327xx` south), which covers most of what surveys
  ship. Anything else is reported as named but not placeable, rather than guessed.

The KML goes to the temp directory and Google Earth Pro is launched by path,
falling back to whatever owns `.kml`.

A cloud whose horizontal system is **geographic** also gets a warning on the
density card: its units are degrees, so every m² figure is meaningless for it.

### Scripting

```js
QCTools.fileInfo.show();                 // the button
QCTools.fileInfo.report();               // the same report as plain text
QCTools.fileInfo.reportModel();          // the document behind it, for scripting
QCTools.fileInfo.reportFile(path);       // any LAS/LAZ/COPC on disk, loaded or not
QCTools.fileInfo.showFile(path);         // and in its own window
QCTools.fileInfo.openInGoogleEarth(places);   // model.places from reportModel()
```

## Defaults on startup

| Setting | Potree default | Here |
| --- | --- | --- |
| Navigation | Orbit | **Earth** |
| Point shape | Square | **Circle** |
| Active attribute | rgba / colour | **Intensity**, when the cloud has it |

Point shape and attribute are applied per cloud as it loads. `desktop.js` sets
the active attribute itself right after adding a cloud on the drag-and-drop path,
so the override is deferred a tick to get the last word. Clouds without an
intensity attribute keep Potree's choice.

## Loader health

A read-only line at the bottom of the panel: how many octree nodes are loaded,
how many of Potree's four load slots are in use, and whether any node is stuck or
was skipped. If the cloud ever stops resolving past its coarse levels, this line
says whether the loader is the reason.

Healthy after an analysis looks like `N nodes loaded, 0/4 slots in use` with no
second line.

## Potree patches

Four changes to `libs/potree/potree.js`, all marked `[QC Tools]`. Re-apply
them after a Potree upgrade.

**1. `Renderer` — tolerate attributes added after a buffer is built.** Three
places read `vbos.get(name)` without checking. `updateBuffer()` already creates a
missing VBO; these just stopped it getting the chance. Without this, adding an
attribute meant tearing down and rebuilding a node's whole GPU buffer set — one
teardown per node, which wrecked rendering whenever many nodes arrived at once.

**2. `Renderer` — tolerate an attribute that is not in the point format.** See
the constraint below.

**3. `NodeLoader` — add `worker.onerror`.** Potree sets `worker.onmessage` but
never `onerror`, so a decoder worker that throws leaves the node flagged
`loading` and never returns its load slot. Potree allows four concurrent loads,
so four such nodes stop *every* load in the application. The patch releases the
node and slot, and gives up on a node after three failed decodes.

**4. `ProfileRequest` — skip nodes flagged `failedToLoad`.** It re-queues any
node that is not yet loaded, so a node that can never load keeps the request
alive forever; it never reaches `onFinish` and whatever awaits it waits for good.

## Constraints worth keeping

Three things that look like improvements and are not. Each caused a
hard-to-diagnose failure.

**Never add anything to `pcoGeometry.pointAttributes`.** It is not a list of
usable attributes — it is the point *format* description, handed straight to the
decoder worker. Registering a 4-byte `density` entry there made the worker expect
four bytes per point that the file does not contain, so every node loaded after
an analysis failed to decode and was skipped permanently. Whole regions then sat
at a coarse level with oversized points that never refined. Density lives only on
the node geometries; the display range comes from `material.setRange()`.

**Do not delete the VAO in `Renderer.deleteBuffer()`.** Potree leaks one per
rebuilt buffer and cleaning it up looks obvious. `gl.deleteVertexArray` does not
exist on this renderer's context — three.js guards the same call behind
`capabilities.isWebGL2` — and adding it froze the viewer during ordinary
navigation, with no tool involved. The leak is small and pre-existing.

**Do not trim the LRU after a scan.** A scan leaves it near `pointLoadLimit`,
which looks like a leak. It is not: `pointLoadLimit` is deliberately
`pointBudget * 2`, so a full cache is the designed state. Forcing eviction below
it throws away nodes the renderer needs and collapses detail.

Two shortcuts for computing density that also do not work:

**Reading point counts from `hierarchy.bin`** instead of the points. The octree
is additive — coarse levels hold a subsample spread across their whole cube — so
per-node counts undercount every cell by 10–25% depending on how the tree fills
out. Fast, and wrong in exactly the way that matters for a contractual threshold.

That the levels are a spread subsample rather than a coarse region is also what
makes the [coverage mask](#the-coverage-mask) cheap: useless for counting,
exactly right for finding out *where* there are points.

**Marking a childless node's whole cube** to work out coverage. Node *existence*
is exact, so this looks sound, but a childless node can be coarse at a sparse
fringe. Measured against a known shape it inflated the area by 48% and filled a
60 m hole in completely. Reading positions from levels 0..3 costs about 40 ms and
is an order of magnitude closer.

**Sampling every Nth point.** Point order inside a node is a spatially structured
scan pattern, so any index-based selection lands on a structured spatial subset,
not a random one. On a uniform 225 pts/m² grid, 1-in-10 sampling reported cells
between 160 and 420 — with a plain stride and again with a hashed index. It is
also not faster: on a cold cache the sampled run took 796 ms against 766 ms for
the exact scan, because the time goes into loading nodes, not the counting loop.

## Verification

Density counting, against a synthetic 10 x 10 m grid at exactly 100 pts/m²:

| Case | Expected | Measured |
| --- | --- | --- |
| 1 x 1 m probe | 100 pts | 100 |
| 2 x 2 m probe | 400 pts | 400 |
| 1 x 1 m, clipped to z ≤ 4.95 | 84 pts | 84 |

Filter awareness, against a grid built as two interleaved collection passes
(GPS time 1000/2000 on alternating x columns, classification 2/5 on alternating
y rows), so every 1 m² splits 50/50:

| Case | Expected | Measured |
| --- | --- | --- |
| No filters | 100 | 100 |
| GPS time, first pass only | 50 | 50 |
| Point source id 3–3 | 50 | 50 |
| Classification 5 hidden | 50 | 50 |
| Clip box covering half the square | 50 | 50 |
| GPS first pass **and** classification 5 hidden | 25 | 25 |

Density colouring, on a 2.25M point cloud at a uniform 225 pts/m²:

| Case | Expected | Measured |
| --- | --- | --- |
| Grid summed × cell area | 2,250,000 (the point count) | 2,250,000 |
| Peak and interior cell value | 225 | 225 |
| Clipped to a quarter | far fewer points read | 613,712, 3 subtrees skipped |
| GPS filtered to one pass | 120 | 120 |
| Rendered colour vs a 50 spec / a 200 spec | green / red | green / red |

Rendering health, on a real 30M point cloud, nine deep zooms across the tile:

| Phase | Decode failures | Nodes loaded |
| --- | --- | --- |
| Navigation only, no tools | 0 | 1,147 |
| Immediately after an analysis | 0 | — |
| Navigating afterwards | 0 | 1,153 |

Repeated use, on a 9M point cloud, every measurement from an identical viewpoint:

| Case | Result |
| --- | --- |
| Baseline detail | level 5, 165 nodes, 1,569,564 pts |
| After an analysis and removing the cut | identical |
| After a **second** analysis on a different area | identical |
| Load slots leaked | 0 of 4 |

File info, against two synthetic clouds whose footprint is known exactly:

- **L-shape** — two 200 x 20 m limbs sharing a corner in a 200 x 200 m box, at
  400 pts/m². True footprint 7,600 m².
- **Annulus + block** — a 100 m radius disc with a 30 m radius hole punched out of
  the middle, plus a detached 40 x 40 m block, at 100 pts/m². True footprint
  30,188 m², one hole, two separate areas.

| Cloud | True | Bounding box | Occupied (node cubes) | Occupied (points) |
| --- | --- | --- | --- | --- |
| L-shape, area | 7,600 m² | 40,000 m² | 9,375 m² | **7,370 m²** |
| L-shape, density | 400 pts/m² | 76.0 (81% low) | 324.3 (19% low) | **412.5 (3.1% high)** |
| Annulus, area | 30,188 m² | 73,595 m² | 44,797 m² | **30,637 m²** |
| Annulus, density | 100 pts/m² | 41.0 (59% low) | 67.4 (33% high) | **98.5 (1.5% low)** |
| Annulus, hole found | 1 | n/a | **0 — filled in** | **1** |

Reading real positions is what makes it usable: an order of magnitude closer, and
it is the only version that finds the hole at all.

Some of the remaining error is the cell grid, not the sampling. Rasterising
**every** point of the source file at the same cell size gives 7,739 m² for the
L-shape and 30,795 m² for the annulus — so the discretisation alone accounts for
+1.8% and +2.0%, and the subsampling contributes the rest. The bias is not
one-directional, which is why the report no longer claims it is.

On a real cloud, checked against a full-resolution raster of all 30,473,594
points of the source LAZ:

| | Full-resolution raster | File info, from 374,510 points |
| --- | --- | --- |
| Coverage area | 395,664 m² | 393,468 m² (0.6% low) |
| Density over coverage | 77.0 pts/m² | 77.4 pts/m² (0.5% high) |

It also found a narrow north-south gap running most of the height of the strip.
That gap is in the full-resolution raster too — a real hole in the data, not an
artefact.

Traced outline geometry, on the annulus cloud:

| Case | Result |
| --- | --- |
| Separate areas / holes | 2 / 1, matching the cloud |
| Hole assigned to | the disc, not the detached block |
| Hole size | 8.5% of the ring it sits in (a 30 m hole in a 100 m disc is 9%) |
| Disc / block area ratio | 20.9 against a true 19.6 |
| Every hole vertex inside its outer ring | yes |
| Any ring crossing itself | none |
| Rings closed, coordinates in lon/lat range | yes |
| KML | well-formed, 2 `Polygon`, 1 `innerBoundaryIs`, 1 `MultiGeometry`, 4 KB |

Also measured, on all four clouds — the two synthetic ones, a 30M point aerial
strip with a source manifest, an 84M point block without one:

| Case | Result |
| --- | --- |
| Occupied area exceeds the bounding box | never (it is clipped to the tight extent) |
| Occupied density below the bounding-box density | never |
| Report time, hierarchy walked and coverage read | 9-43 ms |
| Points read for the mask | 374k-860k, in 26-46 nodes, octree levels 0-3 |
| CRS recovered from the source LAZ where `metadata.json` had none | EPSG:32610, WGS 84 / UTM zone 10N |
| Loader slots or nodes disturbed by a report | 0 |
| Missing `qc_source.json`, missing source file, no cloud loaded | a plain note, no `undefined` or `NaN` |
| `qc_source.json` with a byte order mark | still read (it used to fail silently) |
| Real conversion through the panel, then a report on the result | manifest written, source header read back |
| Select all + copy in the window, read back off the clipboard | every fact from the text report present |
| Toolbar text in that copy | absent |
| Scripts in the report page | 0 |
| Menu bar on the report window | none |
| Worst column gap beside a card | 91 px |
| Sideways scroll at 1180 px wide | none |

The Google Earth path, on the 30M point strip, whose source LAZ declares
EPSG:32610 while its octree metadata declares nothing:

| Case | Result |
| --- | --- |
| Centre of the KML outline | 35.863158, -119.159221 — the independently computed value |
| Shape traced | 1 area, 2 holes, 52 vertices at 5.19 m cells |
| Launch target | `Google Earth Pro\client\googleearth.exe`, found by path |
| A cloud with no CRS (the L-shape) | button disabled and says why, no place offered |

COPC is the one path with no test behind it: there was no COPC file to hand, only
a 133-byte stub. The header and VLR half of the report is shared with LAS and is
covered above; the info block and the hierarchy walk are not, and both are wrapped
so a failure prints a line instead of losing the report.

Interaction:

| Case | Result |
| --- | --- |
| Mouse ray at screen centre, clip box outline visible | 0 hits on the box |
| Same ray, unmodified control BoxVolume in the same place | 1 hit (test is meaningful) |
| Camera position/yaw/pitch/radius on starting the polygon tool | unchanged |
| Double-click to close a polygon | closes, camera unchanged |
| Point under screen centre after drawing | survives the cut |
