/**
 * QC Tools: colour the point cloud from the basemap imagery.
 *
 * These deliveries are intensity-only. Intensity is good at structure and
 * useless at telling you what a thing *is*: a road, a field and a roof can all
 * come back the same grey. Aerial imagery is the opposite, so sampling the
 * imagery per point and painting it onto the cloud puts the two together.
 *
 * It also sidesteps the point cloud opacity problem. Potree's opacity does
 * nothing while EDL is on, so the usual trick of fading the cloud to see the
 * ground beneath it does not work here. A cloud that already carries the ground
 * imagery does not need to be seen through.
 *
 * How it works, and why this way:
 *
 * **The imagery is resampled into a raster keyed by easting and northing**,
 * not left in Web Mercator. Point positions are already in the CRS, so a
 * CRS-aligned raster makes the per-point lookup two subtractions and a divide.
 * Sampling in Mercator instead would mean a proj4 transform per point, which is
 * a few seconds per million points on every node that streams in.
 *
 * **The reprojection is done once per raster cell through a coarse interpolation
 * grid**, and the interpolation error is measured against real proj4 rather than
 * assumed. See `buildRaster`.
 *
 * **Colour rides on Potree's own `rgba` attribute.** The renderer already maps
 * that name to the shader's `color` input, and `activeAttributeName = "rgba"`
 * already compiles the right branch, so no shader change and no sixth potree
 * patch is needed.
 *
 * The honest limit: imagery is 2D. Every point in a vertical column gets the
 * colour of the ground under it, so canopy and the ground beneath it come out
 * the same green. Excellent on ground, roads and roofs; unconvincing in
 * vegetation. The intensity shading below is what keeps structure visible where
 * the colour cannot.
 *
 * Plain script, loaded after qc_map.js. QCTools.install(viewer) calls install().
 */
(function () {
	"use strict";

	const MERCATOR_EDGE = 20037508.342789244;

	// A raster cell is three bytes: red, green and blue.
	//
	// There is deliberately no fourth covered-or-not byte. Dropping it is a
	// quarter of the memory, and the raster is pre-filled with NO_IMAGERY, so a
	// cell that was never painted still reads as "no imagery" without a flag. The
	// only thing that costs is the covered count, which treats a cell that still
	// holds exactly NO_IMAGERY as unpainted; imagery that happens to be that
	// exact colour is miscounted, which is worth a statistic being a hair off.
	const BYTES_PER_CELL = 3;

	// How many cells the raster may use, and so how fine it can be. A cell is
	// one imagery pixel, so the cap is what decides whether a survey gets the
	// zoom's native resolution or a coarsened version of it.
	//
	// Native at zoom 19 is about 0.22 m at mid latitude, so 64M cells covers a
	// survey roughly 1.8 km square before anything has to be given up. Beyond
	// that the cell grows and the panel says so rather than pretending.
	const CELL_BUDGETS = [
		{ id: "native", name: "native, up to 190 MB", cells: 64e6 },
		{ id: "balanced", name: "balanced, up to 48 MB", cells: 16e6 },
		{ id: "light", name: "light, up to 12 MB", cells: 4e6 },
	];

	// Tiles are fetched one at a time so the progress line can move and the
	// window stays responsive. Past this it is a long wait with no warning, so
	// ask for a shallower zoom instead.
	const MAX_TILES = 1024;

	// Cells with no imagery over them. Deliberately not black and not grey: a
	// gap in the coverage should read as a gap, not as dark ground.
	const NO_IMAGERY = [64, 72, 88];

	/**
	 * Ever-increasing, and every buffer this file hands the renderer is stamped
	 * with it.
	 *
	 * The renderer re-uploads an attribute only when `attribute.version >
	 * vbo.version`. A freshly constructed BufferAttribute starts at version 0,
	 * and so does the vbo built from the loader's own `rgba` - so replacing an
	 * existing colour attribute compares 0 against 0, the test is false, and the
	 * GPU quietly keeps the old buffer.
	 *
	 * That is invisible in every number: the geometry holds the right colours,
	 * the attribute is bound, the node count is right. Only the picture is wrong.
	 * On a cloud whose `rgba` is all zeros, which is every PotreeConverter 1.7
	 * octree of a delivery with no RGB, the whole cloud renders black.
	 *
	 * A counter rather than `version++` because the vbo may already be at any
	 * version from earlier passes, and the comparison has to win every time.
	 */
	let uploadTick = 0;

	let installed = false;

	function install(ctx, panel, mapTools) {
		if (installed || !mapTools) {
			return null;
		}
		installed = true;

		const viewer = ctx.viewer;
		const state = {
			zoom: 18,
			budget: CELL_BUDGETS[0],
			structure: 0.5,
			raster: null,
			colouring: false,
			building: false,
			updateHook: null,
			saved: null,
			intensity: null,
		};

		const ui = buildPanel(panel);

		// ------------------------------------------------------------- the raster

		/** Ground metres per tile pixel at a zoom, at this latitude. */
		function groundResolution(zoom, mercatorY) {
			const latitude = 2 * Math.atan(Math.exp(mercatorY / (MERCATOR_EDGE / Math.PI)))
				- Math.PI / 2;
			return (2 * MERCATOR_EDGE / Math.pow(2, zoom) / 256) * Math.cos(latitude);
		}

		/** Web Mercator bounds of one tile. */
		function tileBounds(z, x, y) {
			const span = 2 * MERCATOR_EDGE / Math.pow(2, z);
			return {
				minX: -MERCATOR_EDGE + x * span,
				maxX: -MERCATOR_EDGE + (x + 1) * span,
				maxY: MERCATOR_EDGE - y * span,
				minY: MERCATOR_EDGE - (y + 1) * span,
			};
		}

		/** The cloud's XY footprint in CRS coordinates, which are scene coordinates. */
		function footprint(pointcloud) {
			pointcloud.updateMatrixWorld(true);
			const box = pointcloud.boundingBox.clone().applyMatrix4(pointcloud.matrixWorld);
			return { minX: box.min.x, minY: box.min.y, maxX: box.max.x, maxY: box.max.y };
		}

		/**
		 * A tile as an image, from the cache or the network.
		 *
		 * Wrapped in a blob URL rather than pointed straight at the tile URL: a
		 * canvas that has drawn a cross-origin image cannot be read back, and
		 * `getImageData` throws a security error. A file:// image counts as
		 * cross-origin too, so this is needed in both modes. A blob is
		 * same-origin by definition. (qc_map3d wraps tiles for the same reason,
		 * but to satisfy WebGL rather than the 2D canvas.)
		 */
		async function loadTile(z, x, y) {
			let bytes = null;
			try {
				if (mapTools.isLocal()) {
					const file = mapTools.cacheFile(z, x, y);
					if (!file) {
						return null;
					}
					bytes = require("fs").readFileSync(file);
				} else {
					// Through node's https, so the request carries a User-Agent that
					// identifies this app. OpenStreetMap 403s anything that does not.
					bytes = await mapTools.fetchTile(z, x, y);
					if (!bytes) {
						return null;
					}
				}
			} catch (e) {
				return null;
			}

			const url = URL.createObjectURL(new Blob([bytes]));
			try {
				return await new Promise((resolve) => {
					const image = new Image();
					image.onload = () => resolve(image);
					image.onerror = () => resolve(null);
					image.src = url;
				});
			} finally {
				URL.revokeObjectURL(url);
			}
		}

		/**
		 * CRS to Web Mercator over the whole raster, as a coarse grid to
		 * interpolate through.
		 *
		 * Calling proj4 per raster cell is the obvious way and it is far too slow:
		 * eight million cells is tens of seconds. Both systems are conformal and a
		 * survey is small, so over a few hundred metres the mapping between them
		 * is a similarity transform to well under a pixel, and bilinear
		 * interpolation between sampled corners reproduces it.
		 *
		 * That is an argument, not a measurement, so the grid is checked: the
		 * interpolated position is compared against real proj4 at sample points,
		 * and the grid is refined until the worst error is under a quarter of a
		 * cell. The measured error is reported in the panel rather than assumed.
		 */
		function buildInterpolator(toMercator, extent, cell) {
			const width = extent.maxX - extent.minX;
			const height = extent.maxY - extent.minY;

			for (let divisions = 8; divisions <= 256; divisions *= 2) {
				const n = divisions + 1;
				const mx = new Float64Array(n * n);
				const my = new Float64Array(n * n);

				for (let j = 0; j < n; j++) {
					for (let i = 0; i < n; i++) {
						const point = toMercator.forward([
							extent.minX + width * i / divisions,
							extent.minY + height * j / divisions,
						]);
						mx[j * n + i] = point[0];
						my[j * n + i] = point[1];
					}
				}

				// Written to fill a caller-supplied pair rather than return one, so
				// the per-cell loop below allocates nothing.
				const into = [0, 0];
				const at = (x, y) => {
					const fx = Math.min(divisions - 1e-9, Math.max(0,
						(x - extent.minX) / width * divisions));
					const fy = Math.min(divisions - 1e-9, Math.max(0,
						(y - extent.minY) / height * divisions));
					const i = Math.floor(fx);
					const j = Math.floor(fy);
					const tx = fx - i;
					const ty = fy - j;
					const a = j * n + i;
					const b = a + n;
					into[0] = (mx[a] * (1 - tx) + mx[a + 1] * tx) * (1 - ty)
						+ (mx[b] * (1 - tx) + mx[b + 1] * tx) * ty;
					into[1] = (my[a] * (1 - tx) + my[a + 1] * tx) * (1 - ty)
						+ (my[b] * (1 - tx) + my[b + 1] * tx) * ty;
					return into;
				};

				// Probe off the grid nodes, where the error is largest: on a node the
				// interpolation is exact by construction and would prove nothing. The
				// offsets are irrational fractions of a division for the same reason.
				let worst = 0;
				for (let j = 0; j < 13; j++) {
					for (let i = 0; i < 13; i++) {
						const x = extent.minX + width * (i + 0.4142) / 13;
						const y = extent.minY + height * (j + 0.7321) / 13;
						const truth = toMercator.forward([x, y]);
						const guess = at(x, y);
						worst = Math.max(worst, Math.hypot(
							truth[0] - guess[0], truth[1] - guess[1]));
					}
				}

				// The error is in Mercator metres and the cell is in ground metres.
				// Mercator stretches by 1/cos(latitude), so comparing them directly
				// would flatter the grid at high latitude; scale the cell the same way.
				const midY = at(extent.minX + width / 2, extent.minY + height / 2)[1];
				const stretch = cell / groundResolution(0, midY)
					* (2 * MERCATOR_EDGE / 256);

				if (worst <= stretch / 4 || divisions === 256) {
					// In cells, not metres: the only question worth asking of this
					// error is whether it can move a sample into the next cell.
					return { at: at, divisions: divisions, error: worst / stretch };
				}
			}
			return null;
		}

		/**
		 * Fetches the imagery over the cloud and resamples it into a CRS-aligned
		 * raster. Everything else in this file reads that raster.
		 */
		async function buildRaster() {
			const pointcloud = viewer.scene.pointclouds[0];
			if (!pointcloud || !pointcloud.projection) {
				ui.setStatus("No cloud with a coordinate system, so there is no "
					+ "imagery to look up. Load a cloud whose source file has a CRS.");
				return null;
			}
			if (!viewer.mapView || !viewer.mapView.sceneProjection) {
				ui.setStatus("The map has not placed this cloud yet. Open the Map "
					+ "section and check what it reports.");
				return null;
			}

			let toMercator;
			try {
				toMercator = proj4(pointcloud.projection, "EPSG:3857");
			} catch (e) {
				ui.setStatus("That coordinate system will not map to web mercator.");
				return null;
			}

			const zoom = Math.min(state.zoom, mapTools.providerInfo().maxZoom);
			// No padding: this samples the cloud, not a map drawn around it.
			const range = mapTools.tileRangeAt(zoom, 0);
			const tiles = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
			if (tiles > MAX_TILES) {
				ui.setStatus(`${tiles.toLocaleString()} tiles at zoom ${zoom} is more `
					+ `than this will fetch. Drop the zoom by one and it quarters.`);
				return null;
			}

			const extent = footprint(pointcloud);
			const width = extent.maxX - extent.minX;
			const height = extent.maxY - extent.minY;
			if (!(width > 0) || !(height > 0)) {
				ui.setStatus("The cloud has no horizontal extent to sample.");
				return null;
			}

			const centre = toMercator.forward([
				(extent.minX + extent.maxX) / 2, (extent.minY + extent.maxY) / 2]);

			// One raster cell per imagery pixel is the whole point: any coarser and
			// the colouring throws away detail the tiles actually carry.
			const nativeCell = groundResolution(zoom, centre[1]);
			let cell = nativeCell;

			// A wide survey at a deep zoom would want hundreds of millions of
			// cells. Coarsen rather than refuse, and report it rather than let it
			// look like the imagery was this blurry.
			const wanted = Math.ceil(width / cell) * Math.ceil(height / cell);
			if (wanted > state.budget.cells) {
				cell *= Math.sqrt(wanted / state.budget.cells);
			}

			const nx = Math.max(1, Math.ceil(width / cell));
			const ny = Math.max(1, Math.ceil(height / cell));

			const interpolator = buildInterpolator(toMercator, extent, cell);
			if (!interpolator) {
				ui.setStatus("Could not build a usable transform for this area.");
				return null;
			}

			const rgb = new Uint8Array(nx * ny * BYTES_PER_CELL);
			for (let i = 0; i < rgb.length; i += BYTES_PER_CELL) {
				rgb[i] = NO_IMAGERY[0];
				rgb[i + 1] = NO_IMAGERY[1];
				rgb[i + 2] = NO_IMAGERY[2];
			}

			const raster = {
				minX: extent.minX,
				minY: extent.minY,
				cell: cell,
				nativeCell: nativeCell,
				nx: nx,
				ny: ny,
				rgb: rgb,
				bytes: rgb.length,
				zoom: zoom,
				provider: mapTools.providerInfo().name,
				error: interpolator.error,
				covered: 0,
			};

			const canvas = document.createElement("canvas");
			// willReadFrequently, because every tile drawn here is immediately read
			// back with getImageData. Without it Chromium keeps the canvas on the
			// GPU and each readback is a stall; it warns about exactly this.
			const context = canvas.getContext("2d", { willReadFrequently: true });

			let fetched = 0;
			let missing = 0;

			for (let tx = range.minX; tx <= range.maxX; tx++) {
				for (let ty = range.minY; ty <= range.maxY; ty++) {
					const image = await loadTile(zoom, tx, ty);
					fetched++;

					// Yielding is what actually lets the status line repaint. Without
					// it every update queues behind the whole loop and only the last
					// one is ever seen, so a two minute fetch looks like a hang.
					ui.setStatus(`Fetching imagery: ${Math.round(fetched / tiles * 100)}%`
						+ ` (${fetched} of ${tiles} tiles`
						+ `${missing ? `, ${missing} missing` : ""}).`);
					await new Promise((resolve) => setTimeout(resolve, 0));

					if (!image) {
						missing++;
						continue;
					}

					canvas.width = image.width;
					canvas.height = image.height;
					context.drawImage(image, 0, 0);
					let pixels;
					try {
						pixels = context.getImageData(0, 0, image.width, image.height).data;
					} catch (e) {
						missing++;
						continue;
					}

					raster.covered += paintTile(raster, interpolator, toMercator,
						tileBounds(zoom, tx, ty), pixels, image.width, image.height);
				}
			}

			if (raster.covered === 0) {
				ui.setStatus(mapTools.isLocal()
					? "No cached tiles cover this cloud. Download them first, or "
						+ "switch the Map section back to Stream."
					: "No imagery came back for this area.");
				return null;
			}

			raster.missing = missing;
			return raster;
		}

		/**
		 * Writes one tile's pixels into the raster. Returns the number of cells filled.
		 *
		 * The loop runs over raster cells rather than over tile pixels. Going the
		 * other way leaves holes: the two grids are rotated relative to each other
		 * by the meridian convergence, so a one-to-one walk of source pixels misses
		 * scattered destination cells and the result is stippled.
		 */
		function paintTile(raster, interpolator, toMercator, bounds, pixels, width, height) {
			// Which cells could this tile possibly cover? Corner-inverse to CRS,
			// then a cell of slack for the curvature between the corners.
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const corner of [
				[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY],
				[bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY],
			]) {
				let point;
				try {
					point = toMercator.inverse(corner);
				} catch (e) {
					return 0;
				}
				minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
				minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
			}

			const i0 = Math.max(0, Math.floor((minX - raster.minX) / raster.cell) - 1);
			const i1 = Math.min(raster.nx - 1,
				Math.ceil((maxX - raster.minX) / raster.cell) + 1);
			const j0 = Math.max(0, Math.floor((minY - raster.minY) / raster.cell) - 1);
			const j1 = Math.min(raster.ny - 1,
				Math.ceil((maxY - raster.minY) / raster.cell) + 1);

			const spanX = bounds.maxX - bounds.minX;
			const spanY = bounds.maxY - bounds.minY;
			let filled = 0;

			for (let j = j0; j <= j1; j++) {
				const y = raster.minY + (j + 0.5) * raster.cell;
				for (let i = i0; i <= i1; i++) {
					const x = raster.minX + (i + 0.5) * raster.cell;
					const point = interpolator.at(x, y);

					const u = (point[0] - bounds.minX) / spanX;
					const v = (bounds.maxY - point[1]) / spanY;   // images run top-down
					if (u < 0 || u >= 1 || v < 0 || v >= 1) {
						continue;
					}

					const at = ((Math.floor(v * height) * width) + Math.floor(u * width)) * 4;
					const out = (j * raster.nx + i) * BYTES_PER_CELL;
					if (raster.rgb[out + 0] === NO_IMAGERY[0]
							&& raster.rgb[out + 1] === NO_IMAGERY[1]
							&& raster.rgb[out + 2] === NO_IMAGERY[2]) {
						filled++;
					}
					raster.rgb[out + 0] = pixels[at + 0];
					raster.rgb[out + 1] = pixels[at + 1];
					raster.rgb[out + 2] = pixels[at + 2];
				}
			}

			return filled;
		}

		// ---------------------------------------------------------- intensity

		/**
		 * The intensity stretch, from the coarse octree levels.
		 *
		 * Levels 0 to 3 are a subsample spread across the whole cloud, which is
		 * exactly the property needed here and the same reason the coverage mask
		 * reads them. Taking every Nth point of a full-resolution node instead
		 * would land on a structured spatial subset, because point order inside a
		 * node is the scan pattern, and the histogram would be of one corner of
		 * the delivery rather than of the delivery.
		 *
		 * Percentiles, not the file's own range: one specular return off water or
		 * a road sign sets the maximum and pushes everything else into the bottom
		 * of the scale.
		 */
		function intensityStretch(pointcloud) {
			const values = [];
			for (const node of pointcloud.visibleNodes) {
				if (node.getLevel && node.getLevel() > 3) {
					continue;
				}
				const geometry = node.geometryNode && node.geometryNode.geometry;
				const attribute = geometry && geometry.attributes.intensity;
				if (!attribute) {
					continue;
				}
				const array = attribute.array;
				for (let i = 0; i < array.length; i++) {
					values.push(array[i]);
				}
			}

			if (values.length < 100) {
				// Nothing loaded yet, or no intensity at all. The file's declared
				// range is the only thing left, and it is better than nothing.
				const attributes = pointcloud.pcoGeometry
					&& pointcloud.pcoGeometry.pointAttributes;
				const declared = attributes && (attributes.attributes || [])
					.find((a) => a.name === "intensity");
				if (declared && declared.range) {
					const low = declared.range[0];
					const high = declared.range[1];
					return { low: low, high: high, mid: (low + high) / 2, sampled: 0 };
				}
				return null;
			}

			values.sort((a, b) => a - b);
			const at = (fraction) =>
				values[Math.min(values.length - 1,
					Math.max(0, Math.round(fraction * (values.length - 1))))];

			const low = at(0.02);
			const high = at(0.98);
			return {
				low: low,
				high: high > low ? high : low + 1,
				mid: at(0.5),
				sampled: values.length,
			};
		}

		/**
		 * Intensity as a brightness multiplier, centred so the median point is
		 * left alone.
		 *
		 * A plain linear stretch darkens the whole cloud as the slider comes up,
		 * because most points sit below the midpoint of the range. Splitting the
		 * curve at the median instead means turning the slider up adds contrast
		 * without changing the overall exposure, which is what makes it usable as
		 * a slider rather than as a one-off setting.
		 */
		function shadeFor(stretch, amount) {
			if (!stretch || amount <= 0) {
				return null;
			}

			const low = stretch.low;
			const span = stretch.high - stretch.low;
			const mid = Math.min(0.999, Math.max(0.001, (stretch.mid - low) / span));

			return (raw) => {
				const w = Math.min(1, Math.max(0, (raw - low) / span));
				const centred = w <= mid
					? 0.5 * w / mid
					: 0.5 + 0.5 * (w - mid) / (1 - mid);
				return 1 - amount + amount * 2 * centred;
			};
		}

		// ----------------------------------------------------------- colouring

		/**
		 * Walks a node's points in world coordinates.
		 *
		 * Mirrors the same helper in qc_tools.js. Node positions are stored
		 * relative to the node's own bounding box minimum, so the offset has to go
		 * on before the cloud's world matrix does.
		 */
		function eachPoint(pointcloud, geometryNode, visit) {
			const geometry = geometryNode.geometry;
			const array = geometry.attributes.position.array;
			const count = geometry.attributes.position.count;

			pointcloud.updateMatrixWorld(true);
			const min = geometryNode.boundingBox.min;
			const e = pointcloud.matrixWorld.elements;
			const ox = min.x, oy = min.y, oz = min.z;

			for (let i = 0; i < count; i++) {
				const lx = array[3 * i + 0] + ox;
				const ly = array[3 * i + 1] + oy;
				const lz = array[3 * i + 2] + oz;
				visit(i,
					e[0] * lx + e[4] * ly + e[8] * lz + e[12],
					e[1] * lx + e[5] * ly + e[9] * lz + e[13]);
			}
		}

		/**
		 * Puts the sampled colour on one node, as Potree's own `rgba` attribute.
		 *
		 * Nothing is added to `pcoGeometry.pointAttributes`. That is the point
		 * *format* handed to the decoder worker, and an entry there makes the
		 * worker expect bytes the file does not contain, after which every node
		 * loaded fails to decode permanently. `rgba` needs no entry anyway: the
		 * renderer already knows the name.
		 *
		 * The sampled colour is kept beside the buffer, unshaded, because moving
		 * the structure slider then only has to recombine two numbers per point
		 * instead of walking the raster again.
		 */
		function attachColour(pointcloud, geometryNode) {
			const geometry = geometryNode.geometry;
			const raster = state.raster;
			if (!raster || !geometry || !geometry.attributes.position) {
				return false;
			}
			if (geometry.qcImageryRaster === raster
					&& geometry.qcImageryShade === state.structure) {
				return false;
			}

			const count = geometry.attributes.position.count;

			if (geometry.qcImageryRaster !== raster
					|| !geometry.qcImagerySample
					|| geometry.qcImagerySample.length !== count * 4) {
				const sample = new Uint8Array(count * 4);
				const maxX = raster.minX + raster.nx * raster.cell;
				const maxY = raster.minY + raster.ny * raster.cell;

				eachPoint(pointcloud, geometryNode, (i, x, y) => {
					const out = i * 4;
					if (x < raster.minX || x >= maxX || y < raster.minY || y >= maxY) {
						sample[out + 0] = NO_IMAGERY[0];
						sample[out + 1] = NO_IMAGERY[1];
						sample[out + 2] = NO_IMAGERY[2];
						return;
					}
					const ix = Math.floor((x - raster.minX) / raster.cell);
					const iy = Math.floor((y - raster.minY) / raster.cell);
					// An unpainted cell already holds NO_IMAGERY, so there is
					// nothing to test for: read it either way.
					const at = (iy * raster.nx + ix) * BYTES_PER_CELL;
					sample[out + 0] = raster.rgb[at + 0];
					sample[out + 1] = raster.rgb[at + 1];
					sample[out + 2] = raster.rgb[at + 2];
				});

				geometry.qcImagerySample = sample;
				geometry.qcImageryRaster = raster;
			}

			const sample = geometry.qcImagerySample;
			const existing = geometry.attributes.rgba;

			// A cloud that came with real colour keeps it: the original attribute is
			// put aside and handed back by restore(). Overwriting it in place would
			// mean the only way back was a reload.
			if (existing && !geometry.qcImageryOwns && !geometry.qcOriginalRgba) {
				geometry.qcOriginalRgba = existing;
			}

			const reuse = existing && geometry.qcImageryOwns
				&& existing.array.length === count * 4;
			const values = reuse ? existing.array : new Uint8Array(count * 4);

			const shade = shadeFor(state.intensity, state.structure);
			const intensity = shade && geometry.attributes.intensity
				? geometry.attributes.intensity.array : null;

			for (let i = 0; i < count; i++) {
				const at = i * 4;
				const factor = intensity ? shade(intensity[i]) : 1;
				values[at + 0] = Math.min(255, sample[at + 0] * factor);
				values[at + 1] = Math.min(255, sample[at + 1] * factor);
				values[at + 2] = Math.min(255, sample[at + 2] * factor);
				values[at + 3] = 255;
			}

			if (reuse) {
				// Same buffer, new contents. Bumping the version is what makes the
				// renderer re-upload it on the next frame.
				existing.version = ++uploadTick;
			} else {
				// Uint8 and normalised, exactly as Potree's own loader builds rgba,
				// so the renderer binds it to the shader's colour input with no
				// special case. position's constructor is the plain BufferAttribute,
				// which keeps the array it is given; the typed subclasses would
				// convert it to Float32 and the shader would then read 0..255.
				const attribute =
					new (geometry.attributes.position.constructor)(values, 4, true);
				attribute.version = ++uploadTick;
				geometry.setAttribute("rgba", attribute);
				geometry.qcImageryOwns = true;
			}

			geometry.qcImageryShade = state.structure;
			return true;
		}

		/**
		 * Colours newly streamed-in nodes, a few at a time.
		 *
		 * Same shape as the density colouring: a time budget rather than a node
		 * count, because a node that arrives uncoloured renders with whatever was
		 * last bound to the colour input, and a flash of that while navigating is
		 * exactly what the budget is there to keep short.
		 */
		function refreshLoadedNodes(millisecondBudget) {
			const deadline = millisecondBudget === undefined
				? Infinity
				: performance.now() + millisecondBudget;
			let since = 0;

			for (const pointcloud of viewer.scene.pointclouds) {
				for (const node of pointcloud.visibleNodes) {
					const geometryNode = node.geometryNode;
					if (!geometryNode || !geometryNode.geometry) {
						continue;
					}
					if (!attachColour(pointcloud, geometryNode)) {
						continue;
					}
					// Checking the clock costs more than colouring a small node, so
					// only look every few.
					if (++since >= 4) {
						since = 0;
						if (performance.now() > deadline) {
							return;
						}
					}
				}
			}
		}

		function applyColouring() {
			if (!state.raster) {
				return;
			}

			for (const pointcloud of viewer.scene.pointclouds) {
				if (!state.saved) {
					state.saved = { activeAttributeName: pointcloud.material.activeAttributeName };
				}
				pointcloud.material.activeAttributeName = "rgba";
			}

			state.colouring = true;
			ui.elRestore.prop("disabled", false);
			refreshLoadedNodes();

			if (!state.updateHook) {
				state.updateHook = () => {
					if (state.colouring) {
						refreshLoadedNodes(6);
					}
				};
				viewer.addEventListener("update", state.updateHook);
			}

			describe();
		}

		/**
		 * Back to whatever the cloud was coloured by before.
		 *
		 * Switching `activeAttributeName` back is the whole of it for a cloud that
		 * had no colour: the shader compiles a different branch and never reads
		 * the attribute again. The sampled buffer is deliberately *not* deleted.
		 * It would leave the renderer holding a vbo for an attribute the geometry
		 * no longer lists, which `deleteBuffer` then never frees, and it would
		 * make Show colouring re-walk every point instead of being instant. The
		 * buffer is freed the ordinary way when the node leaves the LRU.
		 *
		 * A cloud that arrived with real colour is the one case that has to be
		 * undone properly, because there its own rgba is the thing being stood on.
		 */
		function restore() {
			state.colouring = false;

			for (const pointcloud of viewer.scene.pointclouds) {
				if (state.saved) {
					pointcloud.material.activeAttributeName = state.saved.activeAttributeName;
				}
				for (const node of pointcloud.visibleNodes) {
					const geometry = node.geometryNode && node.geometryNode.geometry;
					if (!geometry || !geometry.qcOriginalRgba) {
						continue;
					}
					geometry.qcOriginalRgba.version = ++uploadTick;
					geometry.setAttribute("rgba", geometry.qcOriginalRgba);
					delete geometry.qcOriginalRgba;
					delete geometry.qcImageryOwns;
					// Forget the shade too, or a re-apply on a cloud with real colour
					// would think this node was already done and leave it uncoloured.
					delete geometry.qcImageryShade;
				}
			}

			state.saved = null;
			ui.elRestore.prop("disabled", true);
			ui.setStatus("Original colouring restored. The imagery is kept, so "
				+ "Show colouring is instant.");
		}

		/** Re-shades what is already sampled. Cheap enough to run from the slider. */
		function reshade() {
			if (!state.colouring) {
				return;
			}
			refreshLoadedNodes();
			describe();
		}

		function describe() {
			const raster = state.raster;
			if (!raster) {
				return;
			}
			const covered = raster.covered / (raster.nx * raster.ny) * 100;
			const structure = Math.round(state.structure * 100);

			const coarsened = raster.cell > raster.nativeCell * 1.02;
			ui.setStatus(`${raster.provider} at zoom ${raster.zoom}: `
				+ `${raster.cell.toFixed(2)} m cells`
				+ (coarsened
					? ` (coarsened from ${raster.nativeCell.toFixed(2)} m to fit the `
						+ `resolution budget, raise it for full detail)`
					: `, the full detail this imagery carries`)
				+ `, ${(raster.bytes / 1048576).toFixed(0)} MB. Imagery over `
				+ `${covered.toFixed(0)}% of the footprint box`
				+ `${raster.missing ? `, ${raster.missing} tiles missing` : ""}. `
				+ `Reprojection error ${(raster.error * 100).toFixed(0)}% of a cell. `
				+ (state.intensity
					? `Structure from intensity ${structure}%.`
					: `No intensity in this cloud, so the structure slider does nothing.`));
		}

		// ------------------------------------------------------------------- build

		async function build() {
			if (state.building) {
				ui.setStatus("Still fetching. Give it a moment.");
				return;
			}
			state.building = true;
			ui.elBuild.val("Working");
			try {
				const raster = await buildRaster();
				if (!raster) {
					return;
				}

				const pointcloud = viewer.scene.pointclouds[0];
				state.intensity = intensityStretch(pointcloud);
				state.raster = raster;

				ui.elApply.prop("disabled", false);
				applyColouring();
			} finally {
				state.building = false;
				ui.elBuild.val("Fetch imagery");
			}
		}

		// ---------------------------------------------------------------- the UI

		function buildPanel(panel) {
			panel.append($(`
				<div class="divider"><span>Colour from imagery</span></div>
				<li class="qc-dim">Samples the basemap chosen above, per point, at
					each point's easting and northing.</li>
				<li>
					<span class="qc-row">
						<span>Detail</span>
						<select id="qc_img_zoom" style="flex-grow: 1">
							<option value="16">zoom 16, about 2 m pixels</option>
							<option value="17">zoom 17, about 1 m pixels</option>
							<option value="18" selected>zoom 18, about 0.5 m pixels</option>
							<option value="19">zoom 19, about 0.3 m pixels</option>
						</select>
					</span>
				</li>
				<li>
					<span class="qc-row">
						<span>Memory</span>
						<select id="qc_img_budget" style="flex: 1 1 0; min-width: 0">
							${CELL_BUDGETS.map((b) =>
								`<option value="${b.id}">${b.name}</option>`).join("")}
						</select>
					</span>
				</li>
				<li><input id="qc_img_build" type="button" value="Fetch imagery" style="width: 100%"/></li>
				<li>
					<span class="qc-axis">Structure from intensity
						<span id="qc_img_structure_lbl">50</span>%</span>
					<div id="qc_img_structure" class="qc-slider"></div>
				</li>
				<li>
					<span class="qc-row">
						<input id="qc_img_apply" type="button" value="Show colouring" disabled/>
						<span style="flex-grow: 1"></span>
						<input id="qc_img_restore" type="button" value="Restore colours" disabled/>
					</span>
				</li>
				<li id="qc_img_status" class="qc-status">&nbsp;</li>
			`));

			const elStatus = panel.find("#qc_img_status");
			const elLabel = panel.find("#qc_img_structure_lbl");

			panel.find("#qc_img_zoom").on("change", function () {
				state.zoom = Number($(this).val()) || 18;
			});
			panel.find("#qc_img_budget").on("change", function () {
				state.budget = CELL_BUDGETS.find((b) => b.id === $(this).val())
					|| CELL_BUDGETS[0];
			});

			panel.find("#qc_img_structure").slider({
				min: 0,
				max: 100,
				value: 50,
				step: 5,
				slide: (event, slider) => {
					state.structure = slider.value / 100;
					elLabel.text(slider.value);
				},
				// Re-shading walks every loaded point, so it runs when the handle is
				// let go rather than on every pixel of the drag.
				change: () => reshade(),
			});

			const ui = {
				elBuild: panel.find("#qc_img_build"),
				elApply: panel.find("#qc_img_apply"),
				elRestore: panel.find("#qc_img_restore"),
				setStatus: (text) => elStatus.html(text || "&nbsp;"),
			};

			ui.elBuild.click(() => build().catch((e) => {
				console.warn("[QC Tools] imagery colouring failed:", e);
				ui.setStatus("Could not colour from imagery. See the developer console.");
			}));
			ui.elApply.click(applyColouring);
			ui.elRestore.click(restore);

			return ui;
		}

		return {
			build: build,
			apply: applyColouring,
			restore: restore,
			setZoom: (zoom) => {
				state.zoom = zoom;
				$("#qc_img_zoom").val(String(zoom));
			},
			setBudget: (id) => {
				state.budget = CELL_BUDGETS.find((b) => b.id === id) || CELL_BUDGETS[0];
				$("#qc_img_budget").val(state.budget.id);
			},
			setStructure: (amount) => {
				state.structure = amount;
				$("#qc_img_structure").slider("value", Math.round(amount * 100));
			},
			colourAt: (x, y) => {
				const raster = state.raster;
				if (!raster) {
					return null;
				}
				const ix = Math.floor((x - raster.minX) / raster.cell);
				const iy = Math.floor((y - raster.minY) / raster.cell);
				if (ix < 0 || iy < 0 || ix >= raster.nx || iy >= raster.ny) {
					return null;
				}
				const at = (iy * raster.nx + ix) * BYTES_PER_CELL;
				const rgb = [raster.rgb[at], raster.rgb[at + 1], raster.rgb[at + 2]];
				const unpainted = rgb[0] === NO_IMAGERY[0] && rgb[1] === NO_IMAGERY[1]
					&& rgb[2] === NO_IMAGERY[2];
				return unpainted ? null : rgb;
			},
			get raster() { return state.raster; },
			get intensity() { return state.intensity; },
		};
	}

	window.QCImagery = { install: install };
})();
