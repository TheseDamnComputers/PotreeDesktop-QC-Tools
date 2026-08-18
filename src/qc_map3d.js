/**
 * QC Tools: the basemap as ground in the 3D scene.
 *
 * The 2D panel Potree ships is a locator, not integration: a separate widget
 * showing a bounding box. This puts the imagery in the scene itself, under the
 * cloud, at the cloud's own elevation, so the two are one picture.
 *
 * Three things make that work:
 *
 * **Scene coordinates are the CRS coordinates.** `MapView.getMapExtent` feeds
 * `viewer.getBoundingBox()` straight into its proj4 transform, so there is no
 * offset to undo: a mesh placed at easting/northing lands where it belongs.
 *
 * **Each tile is reprojected on its own corners.** Web Mercator and a UTM zone
 * are both conformal, so within one tile the difference is negligible, but
 * across a survey the meridian convergence between them is not. Warping one
 * large quad would smear; four corners per tile does not.
 *
 * **The height comes from the point cloud.** Never from a terrain service: those
 * publish orthometric height above a geoid, while these deliveries record
 * ellipsoidal height. Mixing them is a ~32 m error in California and a different
 * one everywhere else. See QCFileInfo.groundSurface.
 *
 * Plain script, loaded after qc_map.js.
 */
(function () {
	"use strict";

	const MERCATOR_EDGE = 20037508.342789244;
	const MAX_TILES = 400;

	let installed = false;

	function install(ctx, panel, mapTools) {
		if (installed || !mapTools) {
			return null;
		}
		installed = true;

		const viewer = ctx.viewer;
		const state = { heightMode: "auto", offset: 0, opacity: 0.9, group: null,
			method: null, detail: 10, building: false };
		const ui = buildPanel(panel);

		/**
		 * three.js classes, borrowed off live objects.
		 *
		 * The potree bundle does not re-export three, so there is no import to
		 * make. Taking them from objects the viewer already built also guarantees
		 * they are the classes potree itself uses: a second copy of three would
		 * hand back constructors that fail every instanceof check in the renderer.
		 */
		function borrowThree() {
			const pointcloud = viewer.scene.pointclouds[0];
			const node = pointcloud && (pointcloud.visibleNodes || []).find((n) =>
				n.geometryNode && n.geometryNode.geometry
				&& n.geometryNode.geometry.attributes.position);
			if (!node) {
				return null;   // nothing drawn yet, so nothing to borrow from
			}

			const geometry = node.geometryNode.geometry;
			const volume = new Potree.BoxVolume();
			const Colour = Potree.Gradients.RAINBOW[0][1].constructor;

			return {
				Mesh: volume.box.constructor,
				Material: volume.material.constructor,
				Geometry: geometry.constructor,
				Attribute: geometry.attributes.position.constructor,
				// generateDataTexture hands back a DataTexture, which takes raw
				// pixels rather than an Image: constructing one from a decoded tile
				// yields a texture that samples black. Its parent class is the plain
				// Texture, which is the one that accepts an image.
				Texture: Object.getPrototypeOf(
					Potree.Utils.generateDataTexture(1, 1, new Colour(0xffffff)).constructor.prototype
				).constructor,
				Object3D: Object.getPrototypeOf(viewer.scene.scene.constructor.prototype).constructor,
			};
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

		/**
		 * A height lookup over the cloud's own ground raster.
		 *
		 * Two things have to happen before the raster is usable as a surface.
		 * Cells with no points in them hold Infinity, and a vertex there would fly
		 * off to nowhere, so gaps are closed by a few dilation passes averaging
		 * whatever finite neighbours they have. And sampling has to interpolate
		 * between cell centres rather than step from cell to cell, or the mesh
		 * comes out as visible stairs.
		 */
		function makeSampler(ground) {
			const width = ground.width;
			const cell = ground.cell;
			const z = Float32Array.from(ground.minZ);

			const known = Array.from(z).filter(Number.isFinite).sort((a, b) => a - b);
			const fallback = known.length ? known[Math.floor(known.length / 2)] : 0;

			// Grow the known area outwards. Eight passes reaches eight cells past
			// the data, which covers the padding around a survey without turning
			// into a full inpaint.
			for (let pass = 0; pass < 8; pass++) {
				const next = Float32Array.from(z);
				let filled = 0;
				for (let iy = 0; iy < width; iy++) {
					for (let ix = 0; ix < width; ix++) {
						const at = iy * width + ix;
						if (Number.isFinite(z[at])) {
							continue;
						}
						let sum = 0;
						let n = 0;
						for (let dy = -1; dy <= 1; dy++) {
							for (let dx = -1; dx <= 1; dx++) {
								const jx = ix + dx;
								const jy = iy + dy;
								if (jx < 0 || jy < 0 || jx >= width || jy >= width) {
									continue;
								}
								const v = z[jy * width + jx];
								if (Number.isFinite(v)) { sum += v; n++; }
							}
						}
						if (n > 0) { next[at] = sum / n; filled++; }
					}
				}
				z.set(next);
				if (filled === 0) {
					break;
				}
			}

			const value = (ix, iy) => {
				const cx = Math.min(width - 1, Math.max(0, ix));
				const cy = Math.min(width - 1, Math.max(0, iy));
				const v = z[cy * width + cx];
				return Number.isFinite(v) ? v : fallback;
			};

			return (x, y) => {
				const fx = (x - ground.originX) / cell - 0.5;
				const fy = (y - ground.originY) / cell - 0.5;
				const ix = Math.floor(fx);
				const iy = Math.floor(fy);
				const tx = fx - ix;
				const ty = fy - iy;
				const a = value(ix, iy) * (1 - tx) + value(ix + 1, iy) * tx;
				const b = value(ix, iy + 1) * (1 - tx) + value(ix + 1, iy + 1) * tx;
				return a * (1 - ty) + b * ty;
			};
		}

		/** The elevation to lay the ground at, taken from the cloud. */
		function groundHeight(pointcloud) {
			if (state.heightMode === "manual") {
				state.method = "set by hand";
				return state.offset;
			}

			const ground = window.QCFileInfo && window.QCFileInfo.groundFor
				? window.QCFileInfo.groundFor(pointcloud) : null;

			if (!ground) {
				state.method = "cloud minimum, no ground read";
				return (pointcloud.boundingBox ? pointcloud.boundingBox.min.z : 0) + state.offset;
			}

			if (state.heightMode === "ground-class" && ground.groundClassMedian !== null) {
				state.method = `median of ${ground.groundClassPoints} class-2 points`;
				return ground.groundClassMedian + state.offset;
			}

			// The median of the per-cell minima. Measured against a known plane it
			// lands within 6 cm, where the bounding-box minimum was 90 m out
			// because a handful of low outliers drag it down.
			const cells = Array.from(ground.minZ).filter(Number.isFinite).sort((a, b) => a - b);
			if (cells.length > 0) {
				state.method = "median of per-cell ground minima";
				return cells[Math.floor(cells.length / 2)] + state.offset;
			}

			state.method = "2nd percentile of z";
			return ground.lowPercentile + state.offset;
		}

		/**
		 * A tile as an image WebGL will actually accept.
		 *
		 * Pointing an <img> straight at the tile URL renders black: a texture made
		 * from a cross-origin image taints the context and WebGL refuses to sample
		 * it, and a file:// image counts as cross-origin too. Loading the bytes and
		 * wrapping them in an object URL sidesteps it in both modes, because a blob
		 * is same-origin by definition.
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

		async function build() {
			// Fetching tiles takes seconds, and the group is only recorded at the
			// end. A second press during that window used to add a second group
			// that nothing tracked, so Remove cleared one and left the other on
			// screen: "the remove button does not work".
			if (state.building) {
				ui.setStatus("Still placing the last one. Give it a moment.");
				return;
			}
			state.building = true;
			try {
				await buildOnce();
			} finally {
				state.building = false;
			}
		}

		async function buildOnce() {
			remove();

			const pointcloud = viewer.scene.pointclouds[0];
			if (!pointcloud || !pointcloud.projection) {
				ui.setStatus("No cloud with a coordinate system, so there is nothing to place.");
				return;
			}

			const three = borrowThree();
			if (!three) {
				ui.setStatus("The cloud is not drawn yet. Give it a moment and try again.");
				return;
			}

			let toMercator;
			try {
				toMercator = proj4(pointcloud.projection, "EPSG:3857");
			} catch (e) {
				ui.setStatus("That coordinate system will not map to web mercator.");
				return;
			}

			const zoom = mapTools.zoom();
			const range = mapTools.tileRange(zoom);
			const count = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
			if (count > MAX_TILES) {
				ui.setStatus(`${count} tiles at zoom ${zoom} is too many to place. `
					+ `Lower the zoom or the padding.`);
				return;
			}

			const height = groundHeight(pointcloud);

			// A draped mesh needs the raster at the detail the user asked for,
			// which is a different read from the one that produced the flat height.
			let sampler = null;
			if (state.detail > 0 && state.heightMode !== "manual") {
				const ground = window.QCFileInfo && window.QCFileInfo.groundFor
					? window.QCFileInfo.groundFor(pointcloud, state.detail) : null;
				if (ground) {
					const base = makeSampler(ground);
					sampler = (x, y) => base(x, y) + state.offset;
					state.method += `, draped at ${state.detail} m`;
				}
			}

			const group = new three.Object3D();
			group.name = "qc_basemap";

			let placed = 0;
			let fetched = 0;
			ui.setStatus(`Placing ground: 0 of ${count} tiles.`);

			for (let x = range.minX; x <= range.maxX; x++) {
				for (let y = range.minY; y <= range.maxY; y++) {
					const image = await loadTile(zoom, x, y);
					fetched++;

					// Fetching a hundred tiles takes real seconds, and with no sign of
					// progress the button reads as dead. Yielding to the event loop is
					// what actually lets the line repaint; without it the DOM update
					// queues behind the whole loop and only the last one is ever seen.
					ui.setStatus(`Placing ground: ${Math.round(fetched / count * 100)}%`
						+ ` (${fetched} of ${count} tiles`
						+ `${fetched > placed + 1 ? `, ${fetched - placed - (image ? 1 : 0)} missing` : ""})`);
					await new Promise((resolve) => setTimeout(resolve, 0));

					if (!image) {
						continue;
					}

					const b = tileBounds(zoom, x, y);
					const bl = toMercator.inverse([b.minX, b.minY]);
					const br = toMercator.inverse([b.maxX, b.minY]);
					const tr = toMercator.inverse([b.maxX, b.maxY]);
					const tl = toMercator.inverse([b.minX, b.maxY]);

					// Subdivide enough that a quad is about one raster cell across,
					// so the mesh can actually express the surface it is sampling.
					// Flat needs one quad; anything finer is wasted vertices.
					const across = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
					const n = sampler
						? Math.min(16, Math.max(1, Math.round(across / state.detail)))
						: 1;

					const positions = new Float32Array(n * n * 6 * 3);
					const uvs = new Float32Array(n * n * 6 * 2);
					let vi = 0;
					let ti = 0;

					// Bilinear across the tile's own reprojected corners, so each
					// vertex still lands on the true curved edge rather than on a
					// straight line between corners.
					const at = (u, v) => [
						(bl[0] * (1 - u) + br[0] * u) * (1 - v) + (tl[0] * (1 - u) + tr[0] * u) * v,
						(bl[1] * (1 - u) + br[1] * u) * (1 - v) + (tl[1] * (1 - u) + tr[1] * u) * v,
					];

					for (let gx = 0; gx < n; gx++) {
						for (let gy = 0; gy < n; gy++) {
							const u0 = gx / n, u1 = (gx + 1) / n;
							const v0 = gy / n, v1 = (gy + 1) / n;
							const corners = [
								[u0, v0], [u1, v0], [u1, v1],
								[u0, v0], [u1, v1], [u0, v1],
							];
							for (const [u, v] of corners) {
								const point = at(u, v);
								positions[vi++] = point[0];
								positions[vi++] = point[1];
								positions[vi++] = sampler ? sampler(point[0], point[1]) : height;
								// v runs bottom-up because a tile image is stored top-down.
								uvs[ti++] = u;
								uvs[ti++] = v;
							}
						}
					}

					const geometry = new three.Geometry();
					geometry.setAttribute("position", new three.Attribute(positions, 3));
					geometry.setAttribute("uv", new three.Attribute(uvs, 2));

					const texture = new three.Texture(image);
					texture.needsUpdate = true;

					const mesh = new three.Mesh(geometry, new three.Material({
						map: texture,
						transparent: state.opacity < 1,
						opacity: state.opacity,
						depthWrite: state.opacity >= 1,
					}));
					group.add(mesh);
					placed++;
				}
			}

			if (placed === 0) {
				ui.setStatus(mapTools.isLocal()
					? "No cached tiles for that area. Download them first."
					: "No tiles came back for that area.");
				return;
			}

			state.group = group;
			viewer.scene.scene.add(group);
			ui.setStatus(`Ground placed: ${placed} tiles at zoom ${zoom}, `
				+ `height ${height.toFixed(2)} m from the ${state.method}.`);
		}

		/** Applies opacity to a placed ground without rebuilding it. */
		function applyOpacity() {
			if (!state.group) {
				return;
			}
			for (const mesh of state.group.children) {
				mesh.material.opacity = state.opacity;
				mesh.material.transparent = state.opacity < 1;
				mesh.material.needsUpdate = true;
			}
			ui.setStatus(`Ground opacity ${Math.round(state.opacity * 100)}%.`);
		}

		function remove() {
			// Sweep by name rather than trusting the tracked handle alone, so an
			// orphan from an interrupted build cannot survive.
			const groups = viewer.scene.scene.children.filter((c) => c.name === "qc_basemap");
			if (state.group && !groups.includes(state.group)) {
				groups.push(state.group);
			}

			if (groups.length === 0) {
				state.group = null;
				ui.setStatus("No ground placed.");
				return;
			}

			for (const group of groups) {
				viewer.scene.scene.remove(group);
				for (const mesh of group.children) {
					if (mesh.geometry) { mesh.geometry.dispose(); }
					if (mesh.material) {
						if (mesh.material.map) { mesh.material.map.dispose(); }
						mesh.material.dispose();
					}
				}
			}

			state.group = null;
			ui.setStatus(groups.length > 1
				? `Ground removed (${groups.length} layers).`
				: "Ground removed.");
		}

		function buildPanel(panel) {
			panel.append($(`
				<li>
					<span class="qc-row">
						<span>Ground at</span>
						<select id="qc_map3d_height" style="flex-grow: 1">
							<option value="auto">measured ground (auto)</option>
							<option value="ground-class">class 2 ground points</option>
							<option value="manual">this height</option>
						</select>
					</span>
				</li>
				<li>
					<span class="qc-row">
						<span>Detail</span>
						<select id="qc_map3d_detail" style="flex-grow: 1">
							<option value="0">flat plane</option>
							<option value="20">coarse, 20 m</option>
							<option value="10" selected>medium, 10 m</option>
							<option value="5">fine, 5 m</option>
							<option value="2">very fine, 2 m</option>
						</select>
					</span>
				</li>
				<li>
					<span class="qc-row">
						<span>Offset</span>
						<input id="qc_map3d_offset" type="number" step="1" value="0" class="qc-num"/>
						<span>m</span>
						<span style="flex-grow: 1"></span>
						<span>Opacity</span>
						<input id="qc_map3d_opacity" type="number" min="5" max="100" step="5" value="90" class="qc-num"/>
						<span>%</span>
					</span>
				</li>
				<li>
					<span class="qc-row">
						<input id="qc_map3d_build" type="button" value="Show ground in 3D" style="flex-grow: 1"/>
						<input id="qc_map3d_clear" type="button" value="Remove"/>
					</span>
				</li>
				<li id="qc_map3d_status" class="qc-status">&nbsp;</li>
			`));

			const elStatus = panel.find("#qc_map3d_status");
			panel.find("#qc_map3d_detail").on("change", function () {
				state.detail = Number($(this).val()) || 0;
			});
			panel.find("#qc_map3d_height").on("change", function () {
				state.heightMode = $(this).val();
			});
			panel.find("#qc_map3d_offset").on("change", function () {
				state.offset = Number($(this).val()) || 0;
			});
			panel.find("#qc_map3d_opacity").on("change", function () {
				// Percent, because a 0..1 box invites "90" and silently clamps it to
				// 1, which is exactly what it did.
				const percent = Math.min(100, Math.max(5, Number($(this).val()) || 100));
				$(this).val(percent);
				state.opacity = percent / 100;
				applyOpacity();
			});
			panel.find("#qc_map3d_build").click(() => build().catch((e) => {
				console.warn("[QC Tools] ground overlay failed:", e);
				elStatus.html("Could not place the ground. See the developer console.");
			}));
			panel.find("#qc_map3d_clear").click(remove);

			return { setStatus: (text) => elStatus.html(text || "&nbsp;") };
		}

		return {
			build: build,
			remove: remove,
			get height() { return state.group ? state.method : null; },
			get placed() { return state.group ? state.group.children.length : 0; },
		};
	}

	window.QCMap3D = { install: install };
})();
