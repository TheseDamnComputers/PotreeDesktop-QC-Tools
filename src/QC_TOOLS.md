# QC Tools

Additions to PotreeDesktop for point cloud quality checking: measure local point
density, isolate a region, and colour the whole cloud against a density spec.

Everything lives in a **QC Tools** section in the sidebar.

## Files

| File | What it is |
| --- | --- |
| `src/qc_tools.js` | All the tool code |
| `src/qc_tools.css` | Panel styling |
| `index.html` | Three lines: the stylesheet, the script, and `QCTools.install(viewer)` inside `viewer.loadGUI()` |
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

Interaction:

| Case | Result |
| --- | --- |
| Mouse ray at screen centre, clip box outline visible | 0 hits on the box |
| Same ray, unmodified control BoxVolume in the same place | 1 hit (test is meaningful) |
| Camera position/yaw/pitch/radius on starting the polygon tool | unchanged |
| Double-click to close a polygon | closes, camera unchanged |
| Point under screen centre after drawing | survives the cut |
