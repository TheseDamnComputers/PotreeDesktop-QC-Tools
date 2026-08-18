/**
 * QC Tools additions for PotreeDesktop.
 *
 *   1. Density probe - drop an N x N m square on the cloud (footprint seen from
 *      +Z / top) and count every point in the vertical column under it.
 *   2. Box clip sliders - six walls (X min/max, Y min/max, Z min/max) that cut
 *      the cloud down to a single region for closer inspection.
 *
 * Plain script, loaded after potree.js. Call QCTools.install(viewer) from
 * inside viewer.loadGUI(...), once the sidebar markup exists.
 */
(function () {
	"use strict";

	const DEFAULT_SQUARE_SIZE = 1.0;   // metres
	const SLIDER_STEPS = 2000;         // resolution of each clip slider
	const CLICK_SLOP = 4;              // px of mouse travel still counted as a click

	let installed = false;

	function install(viewer) {
		if (installed) {
			return;
		}
		installed = true;

		const ctx = {
			viewer: viewer,
			// The potree bundle does not re-export three.js, so borrow the classes
			// we need from objects the viewer already owns.
			Vector3: viewer.scene.scene.position.constructor,
			setSpriteText: Potree.TextSprite.prototype.setText,
		};

		const panel = createSection("menu_qc_tools", "QC Tools");
		const clipMode = createClipMode(viewer);
		const density = initDensity(ctx, panel);
		initBoxClip(ctx, panel, clipMode);
		const polygon = initPolygonCut(ctx, panel, clipMode);
		const densityColor = initDensityColoring(ctx, panel);
		const scanAngle = initScanAngle(ctx, panel);
		initCutSettings(panel, clipMode);
		// Lives in its own file: it reports on the files rather than driving the
		// viewer, so it shares nothing with the tools above.
		const fileInfo = window.QCFileInfo ? window.QCFileInfo.install(ctx, panel) : null;
		initLoaderHealth(panel, viewer);

		addToolbarButton("#tools", "area.svg",
			"Point density - place a square and count the points under it",
			density.startPicking);
		addToolbarButton("#clipping_tools", "clip-polygon.svg",
			"Polygon cut - draw a shape and keep what is inside it, straight down",
			polygon.start);
		if (fileInfo) {
			addToolbarButton("#tools", "file_las_3d.svg",
				"Point cloud info - everything the file records, as text you can copy",
				fileInfo.show);
		}

		hardenNodeLoader(viewer);
		applyDefaults(viewer);
		// Colour-codes Potree's own Appearance attribute list. Independent of the
		// panel above, so it installs itself against the sidebar rather than here.
		if (window.QCAttrList) {
			window.QCAttrList.install();
		}
		// Lights up Potree's own dormant OpenLayers map by handing it the CRS
		// PotreeConverter drops, and adds the basemap and cache controls.
		window.QCTools.map = window.QCMap ? window.QCMap.install(ctx, panel) : null;
		window.QCTools.map3d = window.QCMap3D
			? window.QCMap3D.install(ctx, panel, window.QCTools.map) : null;

		window.QCTools.density = density;
		window.QCTools.polygon = polygon;
		window.QCTools.densityColor = densityColor;
		window.QCTools.scanAngle = scanAngle;
		window.QCTools.clipMode = clipMode;
		window.QCTools.fileInfo = fileInfo;
	}

	/**
	 * Watches potree's node loader and reports what it sees. Read-only.
	 *
	 * Earlier revisions also tried to repair it from here - clearing the `loading`
	 * flag that dispose() leaves behind, handing leaked slots back. Both are real
	 * defects, but fixing them from outside means clearing a flag that potree uses
	 * as its "a load is in flight" guard, which lets a second load start on a node
	 * that is still loading. Two workers decoding into one node, and for a proxy
	 * node two concurrent hierarchy parses, is a good way to produce exactly the
	 * corruption being chased. The lifecycle has to be fixed where it is owned, in
	 * NodeLoader, not from here.
	 */
	function hardenNodeLoader(viewer) {
		const wedgedSince = new WeakMap();
		let lastSweep = 0;
		let lastHealth = { loaded: 0, wedged: 0 };

		const sweep = () => {
			const now = performance.now();
			let loaded = 0;
			let wedged = 0;

			for (const pointcloud of viewer.scene.pointclouds) {
				const root = pointcloud.pcoGeometry && pointcloud.pcoGeometry.root;
				if (!root) {
					continue;
				}
				const stack = [root];
				while (stack.length > 0) {
					const node = stack.pop();
					if (node.loaded) {
						loaded++;
						wedgedSince.delete(node);
					} else if (node.loading) {
						if (!wedgedSince.has(node)) {
							wedgedSince.set(node, now);
						} else if (now - wedgedSince.get(node) > 5000) {
							wedged++;
						}
					} else {
						wedgedSince.delete(node);
					}
					for (const child of node.getChildren()) {
						stack.push(child);
					}
				}
			}
			return { loaded: loaded, wedged: wedged };
		};

		viewer.addEventListener("update", () => {
			const now = performance.now();
			if (now - lastSweep < 1500) {
				return;
			}
			lastSweep = now;
			lastHealth = sweep();
		});

		viewer.getQCLoaderHealth = () => lastHealth;
	}

	/**
	 * Live readout of the node loader. If the cloud stops resolving past its
	 * coarse levels, this says whether the loader is the reason - the difference
	 * between a diagnosis and a guess.
	 */
	function initLoaderHealth(panel, viewer) {
		panel.append($(`
			<div class="divider"><span>Loader health</span></div>
			<li id="qc_health" class="qc-dim">&nbsp;</li>
		`));

		const el = panel.find("#qc_health");
		let last = 0;

		viewer.addEventListener("update", () => {
			const now = performance.now();
			if (now - last < 900) {
				return;
			}
			last = now;

			// Reuses the sweep hardenNodeLoader already runs, rather than walking
			// every node a second time.
			const health = viewer.getQCLoaderHealth
				? viewer.getQCLoaderHealth()
				: { loaded: 0, wedged: 0 };

			const inFlight = Potree.numNodesLoading;
			const jammed = inFlight >= Potree.maxNodesLoading;
			const failures = Potree.decodeFailures || 0;

			el.html(
				`${health.loaded} nodes loaded, ` +
				`${inFlight}/${Potree.maxNodesLoading} slots in use` +
				(health.wedged ? `, <b>${health.wedged} stuck mid-load</b>` : "") +
				(jammed ? ` &mdash; <b>loader saturated</b>` : "") +
				(failures ? `<br>${failures} nodes would not decode and were skipped` : ""));
		});
	}

	/** Startup and per-cloud defaults we want instead of potree's. */
	function applyDefaults(viewer) {
		// Earth controls rather than potree's orbit default. The Navigation toolbar
		// has no selected-state styling, so there is nothing to sync there.
		if (viewer.earthControls) {
			viewer.setControls(viewer.earthControls);
		}

		const applyToCloud = (pointcloud) => {
			const material = pointcloud.material;

			material.shape = Potree.PointShape.CIRCLE;

			const names = pointcloud.getAttributes().attributes.map((a) => a.name);
			if (names.includes("intensity")) {
				material.activeAttributeName = "intensity";
			}
		};

		viewer.scene.addEventListener("pointcloud_added", (e) => {
			// desktop.js sets activeAttributeName synchronously right after adding the
			// cloud, so claim the last word by deferring past that block.
			setTimeout(() => applyToCloud(e.pointcloud), 0);
		});

		for (const pointcloud of viewer.scene.pointclouds) {
			applyToCloud(pointcloud);
		}
	}

	/**
	 * Volumes are interactive by default: potree raycasts them for dragging, and a
	 * hit swallows the mouse press that would otherwise orbit the camera. The clip
	 * box spans the whole view, so it would block navigation entirely. These boxes
	 * are driven by sliders, not by dragging, so drop them out of picking.
	 */
	function makeNonInteractive(object3d) {
		object3d.raycast = () => {};
	}

	// Only one of the click-driven tools may be armed at a time, otherwise a single
	// click would both drop a density square and add a polygon corner.
	let cancelActiveTool = null;

	function beginExclusive(cancel) {
		if (cancelActiveTool) {
			const previous = cancelActiveTool;
			cancelActiveTool = null;
			previous();
		}
		cancelActiveTool = cancel;
	}

	function endExclusive(cancel) {
		if (cancelActiveTool === cancel) {
			cancelActiveTool = null;
		}
	}

	/**
	 * potree has one global clip task / clip method for every clip volume, so the
	 * box cut and the polygon cuts have to agree. Owning that here keeps them
	 * consistent, and driving potree's own buttons keeps Tools > Clipping honest.
	 */
	function createClipMode(viewer) {
		let invert = false;

		const activeCuts = () =>
			viewer.scene.volumes.filter((v) => v.clip).length +
			viewer.scene.polygonClipVolumes.filter((v) => v.initialized).length;

		function set(groupId, value, fallback) {
			const input = $(`#${groupId} input[value=${value}]`);
			if (input.length) {
				input.trigger("click");
			} else {
				fallback();
			}
		}

		/** @param pending cuts being drawn right now, not yet counted as active. */
		function apply(pending) {
			const count = activeCuts() + (pending || 0);

			if (count === 0) {
				set("cliptask_options", "NONE", () => viewer.setClipTask(Potree.ClipTask.NONE));
				return;
			}

			const task = invert ? "SHOW_OUTSIDE" : "SHOW_INSIDE";
			set("cliptask_options", task, () => viewer.setClipTask(Potree.ClipTask[task]));

			// Two cuts mean "this region AND that region" - intersect them. One cut
			// behaves the same either way, so prefer ANY and leave potree's default.
			const method = count > 1 ? "INSIDE_ALL" : "INSIDE_ANY";
			set("clipmethod_options", method, () => viewer.setClipMethod(Potree.ClipMethod[method]));
		}

		return {
			apply: apply,
			activeCuts: activeCuts,
			setInvert: (value) => { invert = value; apply(); },
			getInvert: () => invert,
		};
	}

	/** Icon in one of potree's toolbars, alongside its own tools. */
	function addToolbarButton(toolbarSelector, iconFile, title, onClick) {
		const toolbar = $(toolbarSelector);
		if (toolbar.length === 0) {
			return;
		}

		const icon = $(`
			<img src="${Potree.resourcePath}/icons/${iconFile}"
				style="width: 32px; height: 32px"
				class="button-icon"
				title="${title}"/>
		`);

		icon.click(() => {
			$("#menu_qc_tools").next().slideDown();
			onClick();
		});

		toolbar.append(icon);
	}

	// ------------------------------------------------------------------ sidebar

	/** Potree's sidebar is a plain list of <h3> + sibling <div>, toggled on click. */
	function createSection(id, title) {
		const header = $(`<h3 id="${id}"><span>${title}</span></h3>`);
		const content = $(`<div class="pv-menu-list qc-panel"></div>`);

		content.hide();
		header.click(() => content.slideToggle());

		const anchor = $("#menu_scene");
		if (anchor.length) {
			header.insertBefore(anchor);
		} else {
			$("#potree_menu").append(header);
		}
		content.insertAfter(header);

		return content;
	}

	function fmt(value, digits) {
		return Potree.Utils.addCommas(value.toFixed(digits === undefined ? 2 : digits));
	}

	// --------------------------------------------------------- visibility filter

	/**
	 * Mirrors, in JS, the tests potree's vertex shader applies to decide whether a
	 * point is drawn: the sidebar's range filters, classification visibility, and
	 * the clip volumes. Lets the density probe count what you can actually see
	 * rather than everything stored on disk.
	 *
	 * Deliberately ignores level-of-detail and the point budget - those change with
	 * camera distance, and a density that moved when you zoomed would be useless.
	 */
	function createVisibilityFilter(ctx) {
		const viewer = ctx.viewer;
		const rules = [];
		const labels = [];

		const narrowed = (range, full) =>
			Array.isArray(range) && (range[0] > full[0] || range[1] < full[1]);

		{ // GPS time - the uniform holds absolute gps time, the buffer does not
			const extent = viewer.getGpsTimeExtent();
			if (isFinite(extent[0]) && narrowed(viewer.filterGPSTimeRange, extent)) {
				rules.push({ kind: "gps", range: viewer.filterGPSTimeRange.slice() });
				labels.push("GPS time");
			}
		}

		const attributeRules = [
			["return number", viewer.filterReturnNumberRange, [0, 7], "return number"],
			["number of returns", viewer.filterNumberOfReturnsRange, [0, 7], "number of returns"],
			["point source id", viewer.filterPointSourceIDRange, [0, 65535], "point source id"],
		];
		for (const [attribute, range, full, label] of attributeRules) {
			if (narrowed(range, full)) {
				rules.push({ kind: "range", attribute: attribute, range: range.slice() });
				labels.push(label);
			}
		}

		{ // classification visibility
			const scheme = viewer.classifications || {};
			const anyHidden = Object.keys(scheme)
				.some((key) => scheme[key] && scheme[key].visible === false);
			if (anyHidden) {
				rules.push({ kind: "classification", scheme: scheme });
				labels.push("classification");
			}
		}

		{ // clip boxes and polygon cuts
			const task = viewer.clipTask;
			const cutting = task === Potree.ClipTask.SHOW_INSIDE ||
				task === Potree.ClipTask.SHOW_OUTSIDE;

			const boxVolumes = viewer.scene.volumes
				.filter((v) => v.clip && v instanceof Potree.BoxVolume);
			boxVolumes.forEach((v) => v.updateMatrixWorld());

			const boxes = boxVolumes.map((v) => v.matrixWorld.clone().invert());
			const polygons = viewer.scene.polygonClipVolumes.filter((v) => v.initialized);

			if (cutting && (boxes.length + polygons.length) > 0) {
				rules.push({
					kind: "clip",
					boxes: boxes,
					boxMatrices: boxVolumes.map((v) => v.matrixWorld.clone()),
					polygons: polygons,
					showInside: task === Potree.ClipTask.SHOW_INSIDE,
					insideAll: viewer.clipMethod === Potree.ClipMethod.INSIDE_ALL,
					scratch: new ctx.Vector3(),
				});
				labels.push("clipping");
			}
		}

		function insideBox(inverse, scratch, x, y, z) {
			scratch.set(x, y, z).applyMatrix4(inverse);
			return scratch.x >= -0.5 && scratch.x <= 0.5 &&
				scratch.y >= -0.5 && scratch.y <= 0.5 &&
				scratch.z >= -0.5 && scratch.z <= 0.5;
		}

		/** Same even-odd crossing test the clip polygon shader runs, in NDC. */
		function insidePolygon(polygon, scratch, x, y, z) {
			scratch.set(x, y, z)
				.applyMatrix4(polygon.viewMatrix)
				.applyMatrix4(polygon.projMatrix);

			const markers = polygon.markers;
			let inside = false;
			for (let i = 0, j = markers.length - 1; i < markers.length; j = i++) {
				const a = markers[i].position;
				const b = markers[j].position;
				if (((a.y > scratch.y) !== (b.y > scratch.y)) &&
					(scratch.x < (b.x - a.x) * (scratch.y - a.y) / (b.y - a.y) + a.x)) {
					inside = !inside;
				}
			}
			return inside;
		}

		/**
		 * Builds a per-chunk test. `read(name)` returns the typed array for an
		 * attribute, so the lookups are resolved once per chunk, not per point.
		 * Profile chunks and raw node geometry hold attributes in the same
		 * representation, so both callers can share this.
		 */
		function accepterFor(pointcloud, read) {
			const checks = [];

			for (const rule of rules) {
				if (rule.kind === "gps") {
					const values = read("gps-time");
					const attribute = pointcloud.getAttribute("gps-time");
					if (!values || !attribute || !attribute.initialRange) {
						continue;
					}
					// Buffer values are normalised against the attribute's initial
					// range; the filter range is absolute. Undo that before comparing.
					const base = attribute.initialRange[0];
					const span = attribute.initialRange[1] - attribute.initialRange[0];
					const [lo, hi] = rule.range;
					checks.push((i) => {
						const t = values[i] * span + base;
						return t >= lo && t <= hi;
					});
				} else if (rule.kind === "range") {
					const values = read(rule.attribute) ||
						(rule.attribute === "point source id" ? read("source id") : null);
					if (!values) {
						continue;
					}
					const [lo, hi] = rule.range;
					checks.push((i) => values[i] >= lo && values[i] <= hi);
				} else if (rule.kind === "classification") {
					const values = read("classification");
					if (!values) {
						continue;
					}
					const scheme = rule.scheme;
					checks.push((i) => {
						const code = values[i];
						const entry = scheme[code] || scheme[code % 32] || scheme.DEFAULT;
						return !entry || entry.visible !== false;
					});
				} else if (rule.kind === "clip") {
					checks.push((i, x, y, z) => {
						let insideCount = 0;
						let total = 0;
						for (const inverse of rule.boxes) {
							total++;
							if (insideBox(inverse, rule.scratch, x, y, z)) insideCount++;
						}
						for (const polygon of rule.polygons) {
							total++;
							if (insidePolygon(polygon, rule.scratch, x, y, z)) insideCount++;
						}
						const inside = rule.insideAll
							? (total > 0 && insideCount === total)
							: insideCount > 0;
						return rule.showInside ? inside : !inside;
					});
				}
			}

			if (checks.length === 0) {
				return null;
			}
			return (i, x, y, z) => {
				for (const check of checks) {
					if (!check(i, x, y, z)) {
						return false;
					}
				}
				return true;
			};
		}

		return {
			active: rules.length > 0,
			labels: labels,
			accepterFor: accepterFor,
			// Exposed so a caller can work out the world footprint of the cuts and
			// only scan that area.
			clipRule: rules.find((r) => r.kind === "clip") || null,
		};
	}

	// ------------------------------------------------------------- density probe

	function initDensity(ctx, panel) {
		const viewer = ctx.viewer;

		panel.append($(`
			<div class="divider"><span>Point density</span></div>
			<li>
				<span class="qc-row">
					<span>Square size</span>
					<input id="qc_density_size" type="number" min="0.05" step="0.1"
						value="${DEFAULT_SQUARE_SIZE}" class="qc-num"/>
					<span>m</span>
					<span style="flex-grow: 1"></span>
					<input id="qc_density_pick" type="button" value="Place square"/>
				</span>
			</li>
			<li class="qc-dim">Counts only points that are currently visible: GPS time,
				return, source id and classification filters and any active cut are
				all applied.</li>
			<li id="qc_density_status" class="qc-status">&nbsp;</li>
			<li><div id="qc_density_results" class="qc-results"></div></li>
			<li>
				<span class="qc-row">
					<input id="qc_density_cancel" type="button" value="Cancel" disabled/>
					<span style="flex-grow: 1"></span>
					<input id="qc_density_clear" type="button" value="Remove all probes"/>
				</span>
			</li>
		`));

		const elSize = panel.find("#qc_density_size");
		const elPick = panel.find("#qc_density_pick");
		const elStatus = panel.find("#qc_density_status");
		const elResults = panel.find("#qc_density_results");
		const elCancel = panel.find("#qc_density_cancel");
		const elClear = panel.find("#qc_density_clear");

		const probes = [];
		let activeRun = null;
		let picking = null;

		const setStatus = (text) => elStatus.html(text || "&nbsp;");

		// Drop probes from the list when they are deleted through the scene tree.
		viewer.scene.addEventListener("volume_removed", (e) => {
			const index = probes.findIndex((p) => p.volume === e.volume);
			if (index >= 0) {
				probes.splice(index, 1);
				renderResults();
			}
		});

		function renderResults() {
			elResults.empty();

			if (probes.length === 0) {
				return;
			}

			for (const probe of probes) {
				const row = $(`<div class="qc-result"></div>`);
				const size = probe.size;
				const area = size * size;

				let body;
				if (probe.count === null) {
					body = `<span class="qc-dim">counting&hellip;</span>`;
				} else {
					const perSqm = probe.count / area;
					const zSpan = (probe.zMin === null)
						? `<span class="qc-dim">no points found</span>`
						: `<span class="qc-dim">z ${fmt(probe.zMin)} &hellip; ${fmt(probe.zMax)} m
							(${fmt(probe.zMax - probe.zMin)} m)</span>`;

					// Only worth showing the unfiltered figure when a filter actually
					// removed something.
					const filtered = probe.total != null && probe.total !== probe.count;
					const context = filtered
						? `<div class="qc-dim">of ${Potree.Utils.addCommas(probe.total)} stored
							(${fmt(probe.total / area, 1)} pts/m&sup2;) &mdash;
							filtered by ${probe.filters.join(", ")}</div>`
						: "";

					body = `
						<b>${Potree.Utils.addCommas(probe.count)} pts</b>
						&nbsp;&rarr;&nbsp; <b>${fmt(perSqm, 1)} pts/m&sup2;</b><br>
						${zSpan}
						${context}`;
				}

				row.append($(`
					<div>
						<span class="qc-row">
							<b>${fmt(size, 2)} &times; ${fmt(size, 2)} m</b>
							<span style="flex-grow: 1"></span>
							<a class="qc-link qc-zoom" title="zoom to probe">zoom</a>
							<a class="qc-link qc-del" title="remove probe">remove</a>
						</span>
						<div class="qc-dim">x ${fmt(probe.center.x)} &nbsp; y ${fmt(probe.center.y)}</div>
						<div>${body}</div>
					</div>
				`));

				row.find(".qc-zoom").click(() => viewer.zoomTo(probe.volume, 1.5, 500));
				row.find(".qc-del").click(() => removeProbe(probe));

				elResults.append(row);
			}
		}

		function removeProbe(probe) {
			const index = probes.indexOf(probe);
			if (index >= 0) {
				probes.splice(index, 1);
			}
			viewer.scene.removeVolume(probe.volume);
			renderResults();
		}

		function createProbe(location) {
			const size = Math.max(0.05, parseFloat(elSize.val()) || DEFAULT_SQUARE_SIZE);
			const cloudBox = viewer.scene.getBoundingBox();
			const zSpan = isFinite(cloudBox.min.z) ? (cloudBox.max.z - cloudBox.min.z) : 1;

			const volume = new Potree.BoxVolume();
			volume.name = `Density ${fmt(size, 2)} x ${fmt(size, 2)} m`;
			volume.clip = false;
			volume.material.color.setHex(0xffaa00);
			volume.material.opacity = 0.22;
			volume.position.set(location.x, location.y, location.z);
			volume.scale.set(size, size, Math.max(zSpan, 0.1));
			volume.rotation.set(0, 0, 0);

			// VolumeTool rewrites every volume label with its m3 volume once per
			// frame. Silence that so the label can carry the density instead.
			volume.label.setText = () => {};
			ctx.setSpriteText.call(volume.label, "counting...");

			makeNonInteractive(volume);
			viewer.scene.addVolume(volume);

			const probe = {
				volume: volume,
				center: location.clone(),
				size: size,
				count: null,
				total: null,
				filters: [],
				zMin: null,
				zMax: null,
			};
			probes.push(probe);
			renderResults();

			runCount(probe);

			return probe;
		}

		function runCount(probe) {
			cancelRun();

			const pointclouds = viewer.scene.pointclouds.slice();
			if (pointclouds.length === 0) {
				setStatus("No point cloud loaded.");
				probe.count = 0;
				probe.total = 0;
				renderResults();
				return;
			}

			// Snapshot the filters now, so a probe reports the view it was taken in
			// even if you move the sliders afterwards.
			const filter = createVisibilityFilter(ctx);
			probe.filters = filter.labels;

			const half = probe.size / 2;
			const profile = new Potree.Profile();
			profile.width = probe.size;
			profile.points = [
				new ctx.Vector3(probe.center.x - half, probe.center.y, probe.center.z),
				new ctx.Vector3(probe.center.x + half, probe.center.y, probe.center.z),
			];

			const run = {
				probe: probe,
				requests: [],
				pending: pointclouds.length,
				count: 0,
				total: 0,
				zMin: Infinity,
				zMax: -Infinity,
				cancelled: false,
			};
			activeRun = run;
			elCancel.prop("disabled", false);
			setStatus(`Counting points in ${fmt(probe.size, 2)} &times; ${fmt(probe.size, 2)} m column&hellip;`);

			const settle = () => {
				run.pending--;
				if (run.pending > 0 || run.cancelled) {
					return;
				}
				activeRun = null;
				elCancel.prop("disabled", true);

				probe.count = run.count;
				probe.total = run.total;
				probe.zMin = isFinite(run.zMin) ? run.zMin : null;
				probe.zMax = isFinite(run.zMax) ? run.zMax : null;

				const area = probe.size * probe.size;
				const perSqm = probe.count / area;

				// Shrink the marker to the vertical extent that was actually counted.
				if (probe.zMin !== null && probe.zMax > probe.zMin) {
					probe.volume.position.z = (probe.zMin + probe.zMax) / 2;
					probe.volume.scale.z = probe.zMax - probe.zMin;
				}
				ctx.setSpriteText.call(probe.volume.label,
					`${fmt(perSqm, 1)} pts/m²`);

				setStatus(`Done - ${Potree.Utils.addCommas(probe.count)} points.`);
				renderResults();
			};

			for (const pointcloud of pointclouds) {
				const offset = pointcloud.position;

				const request = pointcloud.getPointsInProfile(profile, null, {
					onProgress: (event) => {
						if (run.cancelled) {
							return;
						}
						for (const segment of event.points.segments) {
							const points = segment.points;
							const n = points.numPoints;
							if (n === 0) {
								continue;
							}
							run.total += n;

							// Positions are stored world-space minus pointcloud.position.
							const pos = points.data.position;
							const accepts = pos
								? filter.accepterFor(pointcloud, (name) => points.data[name])
								: null;

							if (!pos || !accepts) {
								// Nothing to filter on: the profile already bounds x/y, and
								// the chunk bounding box is already in world space.
								run.count += n;
								const bb = points.boundingBox;
								if (isFinite(bb.min.z)) {
									run.zMin = Math.min(run.zMin, bb.min.z);
									run.zMax = Math.max(run.zMax, bb.max.z);
								}
								continue;
							}

							for (let i = 0; i < n; i++) {
								const x = pos[3 * i + 0] + offset.x;
								const y = pos[3 * i + 1] + offset.y;
								const z = pos[3 * i + 2] + offset.z;
								if (!accepts(i, x, y, z)) {
									continue;
								}
								run.count++;
								if (z < run.zMin) run.zMin = z;
								if (z > run.zMax) run.zMax = z;
							}
						}
						setStatus(`Counting&hellip; ${Potree.Utils.addCommas(run.count)} points so far.`);
					},
					onFinish: settle,
					onCancel: settle,
				});

				run.requests.push(request);
			}
		}

		function cancelRun() {
			if (!activeRun) {
				return;
			}
			const run = activeRun;
			run.cancelled = true;
			activeRun = null;
			elCancel.prop("disabled", true);
			for (const request of run.requests) {
				try {
					request.cancel();
				} catch (e) {
					// request already finished
				}
			}
			if (run.probe.count === null) {
				run.probe.count = run.count;
				run.probe.total = run.total;
				run.probe.zMin = isFinite(run.zMin) ? run.zMin : null;
				run.probe.zMax = isFinite(run.zMax) ? run.zMax : null;
			}
			renderResults();
		}

		// ---- picking

		function stopPicking() {
			if (!picking) {
				return;
			}
			const domElement = viewer.renderer.domElement;
			domElement.removeEventListener("mousedown", picking.onDown, false);
			domElement.removeEventListener("mouseup", picking.onUp, false);
			window.removeEventListener("keydown", picking.onKey, false);
			domElement.style.cursor = picking.cursor;
			elPick.val("Place square");
			endExclusive(picking.token);
			picking = null;
		}

		function startPicking() {
			if (picking) {
				stopPicking();
				setStatus("");
				return;
			}

			const domElement = viewer.renderer.domElement;
			const state = {
				cursor: domElement.style.cursor,
				downAt: null,
			};

			state.onDown = (e) => {
				state.downAt = { x: e.clientX, y: e.clientY, button: e.button };
			};

			state.onUp = (e) => {
				const down = state.downAt;
				state.downAt = null;

				if (e.button === 2) {
					stopPicking();
					setStatus("");
					return;
				}
				if (e.button !== 0 || !down) {
					return;
				}
				// Ignore the mouseup that ends an orbit / pan drag.
				const travel = Math.hypot(e.clientX - down.x, e.clientY - down.y);
				if (travel > CLICK_SLOP) {
					return;
				}

				const I = Potree.Utils.getMousePointCloudIntersection(
					viewer.inputHandler.mouse,
					viewer.scene.getActiveCamera(),
					viewer,
					viewer.scene.pointclouds,
					{ pickClipped: true });

				stopPicking();

				if (!I) {
					setStatus("Nothing hit there - click on the point cloud.");
					return;
				}
				createProbe(I.location);
			};

			state.onKey = (e) => {
				if (e.key === "Escape") {
					stopPicking();
					setStatus("");
				}
			};

			picking = state;
			state.token = () => { stopPicking(); setStatus(""); };
			beginExclusive(state.token);

			domElement.style.cursor = "crosshair";
			domElement.addEventListener("mousedown", state.onDown, false);
			domElement.addEventListener("mouseup", state.onUp, false);
			window.addEventListener("keydown", state.onKey, false);

			elPick.val("Click cloud…");
			setStatus("Click a spot on the cloud. Right-click or Esc to cancel.");
		}

		elPick.click(startPicking);
		elCancel.click(() => {
			cancelRun();
			setStatus("Cancelled.");
		});
		elClear.click(() => {
			cancelRun();
			for (const probe of probes.slice()) {
				viewer.scene.removeVolume(probe.volume);
			}
			probes.length = 0;
			renderResults();
			setStatus("");
		});

		return {
			startPicking: startPicking,
			// Scripting hook: drop a probe without clicking. Returns the probe
			// record, whose `count` stays null until the octree walk finishes.
			probeAt: (x, y, z) => createProbe(new ctx.Vector3(x, y, z)),
			probes: probes,
		};
	}

	// ---------------------------------------------------------- box clip sliders

	function initBoxClip(ctx, panel, clipMode) {
		const viewer = ctx.viewer;

		panel.append($(`
			<div class="divider"><span>Box clip</span></div>
			<li><label><input id="qc_clip_enable" type="checkbox"/>
				Isolate a box (hides everything outside)</label></li>
			<li>
				<span class="qc-axis">X &nbsp;<span class="qc-dim">left &harr; right</span></span>
				<div id="qc_clip_x" class="qc-slider"></div>
				<div id="qc_clip_x_lbl" class="qc-dim"></div>
			</li>
			<li>
				<span class="qc-axis">Y &nbsp;<span class="qc-dim">front &harr; back</span></span>
				<div id="qc_clip_y" class="qc-slider"></div>
				<div id="qc_clip_y_lbl" class="qc-dim"></div>
			</li>
			<li>
				<span class="qc-axis">Z &nbsp;<span class="qc-dim">bottom &harr; top</span></span>
				<div id="qc_clip_z" class="qc-slider"></div>
				<div id="qc_clip_z_lbl" class="qc-dim"></div>
			</li>
			<li><label><input id="qc_clip_outline" type="checkbox" checked/>
				Show box outline</label></li>
			<li>
				<span class="qc-row">
					<input id="qc_clip_shrink" type="button" value="Zoom sliders to box"/>
					<span style="flex-grow: 1"></span>
					<input id="qc_clip_zoom" type="button" value="Zoom view"/>
				</span>
			</li>
			<li><input id="qc_clip_reset" type="button" value="Reset to full cloud"/></li>
		`));

		const elEnable = panel.find("#qc_clip_enable");
		const elOutline = panel.find("#qc_clip_outline");
		const elReset = panel.find("#qc_clip_reset");
		const elZoom = panel.find("#qc_clip_zoom");
		const elShrink = panel.find("#qc_clip_shrink");

		const axes = {
			x: { slider: panel.find("#qc_clip_x"), label: panel.find("#qc_clip_x_lbl") },
			y: { slider: panel.find("#qc_clip_y"), label: panel.find("#qc_clip_y_lbl") },
			z: { slider: panel.find("#qc_clip_z"), label: panel.find("#qc_clip_z_lbl") },
		};

		let volume = null;
		let bounds = null;     // cloud extent the sliders map onto

		function currentBounds() {
			const box = viewer.scene.getBoundingBox();
			if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
				return null;
			}
			return box;
		}

		function axisRange(axis) {
			// Guard against a zero-thickness cloud on any axis.
			const lo = bounds.min[axis];
			const hi = bounds.max[axis];
			return (hi - lo) > 1e-6 ? { lo: lo, hi: hi } : { lo: lo - 0.5, hi: lo + 0.5 };
		}

		function toWorld(axis, step) {
			const r = axisRange(axis);
			return r.lo + (r.hi - r.lo) * (step / SLIDER_STEPS);
		}

		function selection() {
			if (!bounds) {
				return null;
			}
			const out = {};
			for (const axis of ["x", "y", "z"]) {
				const values = axes[axis].slider.slider("values");
				out[axis] = { min: toWorld(axis, values[0]), max: toWorld(axis, values[1]) };
			}
			return out;
		}

		function updateLabels(sel) {
			for (const axis of ["x", "y", "z"]) {
				const s = sel[axis];
				axes[axis].label.html(
					`${fmt(s.max - s.min)} m &nbsp;<span class="qc-faint">` +
					`[${fmt(s.min)} &hellip; ${fmt(s.max)}]</span>`);
			}
		}

		function applyToVolume() {
			const sel = selection();
			if (!sel) {
				return;
			}
			updateLabels(sel);

			if (!volume) {
				return;
			}
			volume.position.set(
				(sel.x.min + sel.x.max) / 2,
				(sel.y.min + sel.y.max) / 2,
				(sel.z.min + sel.z.max) / 2);
			volume.scale.set(
				Math.max(sel.x.max - sel.x.min, 1e-4),
				Math.max(sel.y.max - sel.y.min, 1e-4),
				Math.max(sel.z.max - sel.z.min, 1e-4));
			volume.rotation.set(0, 0, 0);
			volume.updateMatrixWorld(true);
		}

		function buildSliders() {
			for (const axis of ["x", "y", "z"]) {
				const el = axes[axis].slider;
				if (el.data("uiSlider") || el.hasClass("ui-slider")) {
					el.slider("values", [0, SLIDER_STEPS]);
					continue;
				}
				el.slider({
					range: true,
					min: 0,
					max: SLIDER_STEPS,
					values: [0, SLIDER_STEPS],
					slide: (event, ui) => {
						// Keep the two handles from crossing over.
						if (ui.values[0] >= ui.values[1]) {
							return false;
						}
						setTimeout(applyToVolume, 0);
					},
					change: () => applyToVolume(),
				});
			}
		}

		function resetBounds() {
			const box = currentBounds();
			if (!box) {
				return false;
			}
			bounds = box;
			for (const axis of ["x", "y", "z"]) {
				axes[axis].slider.slider("values", [0, SLIDER_STEPS]);
			}
			applyToVolume();
			return true;
		}

		function enable() {
			if (!bounds && !resetBounds()) {
				elEnable.prop("checked", false);
				viewer.postMessage("Load a point cloud first.", { duration: 3000 });
				return;
			}

			if (!volume) {
				volume = new Potree.BoxVolume();
				volume.name = "Clip box (sliders)";
				volume.showVolumeLabel = false;
				volume.clip = true;
				volume.visible = elOutline.prop("checked");
				// The outline stays visible but stops eating mouse presses, so the
				// camera can still be orbited from inside the box.
				makeNonInteractive(volume);
				viewer.scene.addVolume(volume);
			}

			applyToVolume();
			clipMode.apply();
		}

		function disable() {
			if (volume) {
				viewer.scene.removeVolume(volume);
				volume = null;
			}
			clipMode.apply();
		}

		// Keep the checkbox honest if the volume is deleted from the scene tree.
		viewer.scene.addEventListener("volume_removed", (e) => {
			if (volume && e.volume === volume) {
				volume = null;
				elEnable.prop("checked", false);
				clipMode.apply();
			}
		});

		// First cloud to arrive defines the slider range.
		viewer.scene.addEventListener("pointcloud_added", () => {
			if (!bounds) {
				resetBounds();
			}
		});

		buildSliders();
		resetBounds();

		elEnable.click(() => elEnable.prop("checked") ? enable() : disable());
		elOutline.click(() => {
			if (volume) {
				volume.visible = elOutline.prop("checked");
			}
		});
		elReset.click(() => {
			if (!resetBounds()) {
				viewer.postMessage("Load a point cloud first.", { duration: 3000 });
			}
		});
		// PotreeConverter 2.0 stores a cubic bounding box, so on a flat cloud most
		// of the Z slider travel is empty air. Re-base the sliders onto the current
		// box to spend the full travel - and the full precision - on it.
		elShrink.click(() => {
			const sel = selection();
			if (!sel) {
				return;
			}
			bounds = {
				min: { x: sel.x.min, y: sel.y.min, z: sel.z.min },
				max: { x: sel.x.max, y: sel.y.max, z: sel.z.max },
			};
			for (const axis of ["x", "y", "z"]) {
				axes[axis].slider.slider("values", [0, SLIDER_STEPS]);
			}
			applyToVolume();
		});
		elZoom.click(() => {
			if (volume) {
				viewer.zoomTo(volume, 1.2, 500);
			}
		});

		// Exposed so the density probe can restrict its count to the isolated box.
		window.QCTools.getClipBounds = () => {
			if (!volume || !elEnable.prop("checked")) {
				return null;
			}
			const sel = selection();
			if (!sel) {
				return null;
			}
			return {
				min: { x: sel.x.min, y: sel.y.min, z: sel.z.min },
				max: { x: sel.x.max, y: sel.y.max, z: sel.z.max },
			};
		};
	}

	// ------------------------------------------------------------- polygon cut

	/**
	 * Corners are picked in 3D, from wherever the camera happens to be - the view
	 * is never moved, navigation stays live, and only the x/y of each corner is
	 * used. The cut itself is built afterwards against a synthetic top-down
	 * orthographic camera, which is what makes it a true vertical prism rather
	 * than the diverging frustum you get from extruding along a perspective view.
	 */
	function initPolygonCut(ctx, panel, clipMode) {
		const viewer = ctx.viewer;
		const MAX_VERTICES = 8;   // hard limit in potree's clip polygon shader

		panel.append($(`
			<div class="divider"><span>Polygon cut (top-down)</span></div>
			<li><input id="qc_poly_start" type="button" value="Draw polygon"
				style="width: 100%"/></li>
			<li id="qc_poly_status" class="qc-status">&nbsp;</li>
			<li><input id="qc_poly_clear" type="button" value="Remove all polygon cuts"
				style="width: 100%"/></li>
		`));

		const elStart = panel.find("#qc_poly_start");
		const elStatus = panel.find("#qc_poly_status");
		const elClear = panel.find("#qc_poly_clear");

		const setStatus = (text) => elStatus.html(text || "&nbsp;");

		let drawing = null;

		function hint() {
			const n = drawing.points.length;
			if (n < 3) {
				setStatus(`${n} corner${n === 1 ? "" : "s"} - at least 3 needed. ` +
					`Double-click or right-click to finish, Esc to cancel.`);
			} else {
				setStatus(`${n} corners (max ${MAX_VERTICES}) - ` +
					`double-click or right-click to finish, Esc to cancel.`);
			}
		}

		/** Ray through the mouse, correct for both camera types. */
		function mouseRay() {
			const camera = viewer.scene.getActiveCamera();
			const dom = viewer.renderer.domElement;
			const mouse = viewer.inputHandler.mouse;
			const nx = (mouse.x / dom.clientWidth) * 2 - 1;
			const ny = -(mouse.y / dom.clientHeight) * 2 + 1;
			const V = ctx.Vector3;

			const isOrtho = camera.isOrthographicCamera || typeof camera.left === "number";
			if (isOrtho) {
				// Under an orthographic camera every ray is parallel, so the origin has
				// to come from the unprojected near plane, not from camera.position.
				return {
					origin: new V(nx, ny, -1).unproject(camera),
					direction: camera.getWorldDirection(new V()),
				};
			}
			const origin = camera.position.clone();
			return {
				origin: origin,
				direction: new V(nx, ny, 0.5).unproject(camera).sub(origin).normalize(),
			};
		}

		/**
		 * Prefer a real point on the cloud. Fall back to a horizontal plane at
		 * planeZ, otherwise you could not put a corner on empty sky - which is
		 * exactly what drawing *around* an object requires.
		 */
		function pickCorner(planeZ) {
			const I = Potree.Utils.getMousePointCloudIntersection(
				viewer.inputHandler.mouse,
				viewer.scene.getActiveCamera(),
				viewer,
				viewer.scene.pointclouds,
				{ pickClipped: true });

			if (I) {
				return I.location.clone();
			}

			const ray = mouseRay();
			if (Math.abs(ray.direction.z) < 1e-9) {
				return null;
			}
			const t = (planeZ - ray.origin.z) / ray.direction.z;
			if (t <= 0) {
				return null;
			}
			return ray.direction.clone().multiplyScalar(t).add(ray.origin);
		}

		function addCorner() {
			const box = viewer.scene.getBoundingBox();
			const fallbackZ = drawing.points.length > 0
				? drawing.points[drawing.points.length - 1].z
				: (isFinite(box.min.z) ? (box.min.z + box.max.z) / 2 : 0);

			const point = pickCorner(fallbackZ);
			if (!point) {
				setStatus("Could not place a corner there - try again.");
				return;
			}

			drawing.points.push(point);
			drawing.preview.addMarker(point);
			// Preview markers must not become click targets, or the next corner would
			// drag the previous one instead of being placed.
			for (const sphere of drawing.preview.spheres) {
				makeNonInteractive(sphere);
			}

			hint();

			if (drawing.points.length >= MAX_VERTICES) {
				setStatus(`Reached the ${MAX_VERTICES}-corner limit - closing the shape.`);
				finish(true);
			}
		}

		function teardown() {
			if (!drawing) {
				return;
			}
			const dom = viewer.renderer.domElement;
			dom.removeEventListener("mousedown", drawing.onDown, false);
			dom.removeEventListener("mouseup", drawing.onUp, false);
			window.removeEventListener("dblclick", drawing.onDblClick, true);
			dom.removeEventListener("contextmenu", drawing.onContextMenu, false);
			window.removeEventListener("keydown", drawing.onKey, false);
			dom.style.cursor = drawing.cursor;

			viewer.scene.removeMeasurement(drawing.preview);
			elStart.val("Draw polygon");
			endExclusive(drawing.token);

			const points = drawing.points;
			drawing = null;
			return points;
		}

		function finish(commit) {
			const points = teardown() || [];

			if (!commit) {
				setStatus("Cancelled.");
				return;
			}
			if (points.length < 3) {
				setStatus("Cancelled - a polygon needs at least 3 corners.");
				return;
			}

			result.lastPoints = points;
			createCut(points);
			setStatus(`Cut applied (${points.length} corners). ` +
				`Draw another to narrow it down further.`);
		}

		function createCut(points) {
			// A three.js camera with no rotation looks straight down -Z, so an
			// unrotated orthographic camera above the scene *is* the top-down view.
			// Nothing about the user's actual camera is touched.
			const camera = viewer.scene.cameraO.clone();
			if (camera.clearViewOffset) {
				camera.clearViewOffset();
			}

			let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
			for (const p of points) {
				minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
				minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
				maxZ = Math.max(maxZ, p.z);
			}

			// Only the ratio matters - the shader does plain 2D point-in-polygon in
			// NDC - but padding keeps the coordinates near [-1, 1].
			const halfW = Math.max((maxX - minX) * 0.6, 1);
			const halfH = Math.max((maxY - minY) * 0.6, 1);

			camera.left = -halfW;
			camera.right = halfW;
			camera.top = halfH;
			camera.bottom = -halfH;
			camera.zoom = 1;
			camera.near = 0.1;
			camera.far = 1e6;
			camera.position.set((minX + maxX) / 2, (minY + maxY) / 2, maxZ + 1000);
			camera.rotation.set(0, 0, 0);
			camera.up.set(0, 1, 0);
			camera.updateMatrixWorld(true);
			camera.updateProjectionMatrix();

			const polygon = new Potree.PolygonClipVolume(camera);
			polygon.name = "Polygon cut " + (viewer.scene.polygonClipVolumes.length + 1);

			for (const p of points) {
				polygon.addMarker();
				const marker = polygon.markers[polygon.markers.length - 1];
				const ndc = p.clone()
					.applyMatrix4(polygon.viewMatrix)
					.applyMatrix4(polygon.projMatrix);
				marker.position.set(ndc.x, ndc.y, 0);
			}

			polygon.initialized = true;
			viewer.scene.addPolygonClipVolume(polygon);
			clipMode.apply();
		}

		function start() {
			if (drawing) {
				finish(false);
				return;
			}
			if (viewer.scene.pointclouds.length === 0) {
				viewer.postMessage("Load a point cloud first.", { duration: 3000 });
				return;
			}

			const dom = viewer.renderer.domElement;
			const preview = new Potree.Measure();
			preview.name = "polygon (drawing)";
			preview.showDistances = false;
			preview.showArea = false;
			preview.showAngles = false;
			preview.showCoordinates = false;
			preview.showHeight = false;
			preview.showCircle = false;
			preview.showAzimuth = false;
			preview.showEdges = true;
			preview.closed = true;
			preview.maxMarkers = MAX_VERTICES;
			viewer.scene.addMeasurement(preview);

			drawing = {
				points: [],
				preview: preview,
				cursor: dom.style.cursor,
				downAt: null,
			};

			drawing.onDown = (e) => {
				drawing.downAt = { x: e.clientX, y: e.clientY };
			};

			drawing.onUp = (e) => {
				const down = drawing.downAt;
				drawing.downAt = null;

				if (e.button !== 0 || !down) {
					return;
				}
				// Navigation stays enabled while drawing, so ignore the mouseup that
				// ends an orbit or pan.
				if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) {
					return;
				}
				addCorner();
			};

			drawing.onDblClick = (event) => {
				if (event.target !== dom) {
					return;
				}
				// potree binds double-click to zoom-to-point on the canvas itself, and
				// it binds it once at construction, so the method cannot be patched.
				// Killing the event during capture on the way down is what keeps the
				// close gesture from also flying the camera in.
				event.stopPropagation();
				event.preventDefault();

				// The second click of the double-click already added a duplicate
				// corner; drop it, then close.
				if (drawing && drawing.points.length > 1) {
					drawing.points.pop();
					drawing.preview.removeMarker(drawing.preview.points.length - 1);
				}
				finish(true);
			};

			drawing.onContextMenu = (e) => {
				e.preventDefault();
				finish(true);
			};

			drawing.onKey = (e) => {
				if (e.key === "Escape") {
					finish(false);
				}
			};

			drawing.token = () => finish(false);
			beginExclusive(drawing.token);

			dom.style.cursor = "crosshair";
			dom.addEventListener("mousedown", drawing.onDown, false);
			dom.addEventListener("mouseup", drawing.onUp, false);
			window.addEventListener("dblclick", drawing.onDblClick, true);
			dom.addEventListener("contextmenu", drawing.onContextMenu, false);
			window.addEventListener("keydown", drawing.onKey, false);

			elStart.val("Cancel drawing");
			hint();
		}

		elStart.click(start);

		elClear.click(() => {
			for (const polygon of viewer.scene.polygonClipVolumes.slice()) {
				viewer.scene.removePolygonClipVolume(polygon);
			}
			clipMode.apply();
			setStatus("");
		});

		const result = {
			start: start,
			// Scripting hook: build a cut from world coordinates, no clicking.
			// Accepts Vector3s or [x, y, z] triples; only x/y are used.
			cutFromPoints: (points) => createCut(points.map(
				(p) => Array.isArray(p) ? new ctx.Vector3(p[0], p[1], p[2]) : p)),
			// Corners of the most recently drawn polygon, in world coordinates.
			lastPoints: null,
		};
		return result;
	}

	// -------------------------------------------------------- density colouring

	const DENSITY_ATTRIBUTE = "density";

	/**
	 * Colours the cloud by local point density (pts/m2) so a delivery can be
	 * checked against a spec like "50 ppsm", with everything below the threshold
	 * forced to red.
	 *
	 * Density is counted per square grid cell over the full-resolution data, which
	 * is what survey specs mean by points per square metre. That requires reading
	 * every point once - there is no shortcut, because potree's octree is additive
	 * and the coarse levels hold a subsample spread across their whole cube, so
	 * hierarchy point counts alone would undercount every cell.
	 *
	 * The result rides on potree's own "extra attribute" path: a float attribute
	 * named `density` is attached to each node, which gets bound to aExtra and run
	 * through the gradient. That buys the sidebar's attribute list, range slider
	 * and gradient picker for free.
	 */
	function initDensityColoring(ctx, panel) {
		const viewer = ctx.viewer;

		panel.append($(`
			<div class="divider"><span>Density colouring</span></div>
			<li>
				<span class="qc-row">
					<span>Cell</span>
					<input id="qc_dc_cell" type="number" min="0.1" step="0.5" value="1" class="qc-num"/>
					<span>m</span>
					<span style="flex-grow: 1"></span>
					<span class="qc-dim">clip first to scan less</span>
				</span>
			</li>
			<li><input id="qc_dc_run" type="button" value="Analyse density" style="width: 100%"/></li>
			<li id="qc_dc_status" class="qc-status">&nbsp;</li>
			<li>
				<span class="qc-axis">Red below <span id="qc_dc_threshold_lbl">50</span> pts/m&sup2;</span>
				<div id="qc_dc_threshold" class="qc-slider"></div>
			</li>
			<li><div id="qc_dc_legend"></div></li>
			<li>
				<span class="qc-row">
					<input id="qc_dc_apply" type="button" value="Show colouring" disabled/>
					<span style="flex-grow: 1"></span>
					<input id="qc_dc_reset" type="button" value="Restore colours" disabled/>
				</span>
			</li>
		`));

		const elCell = panel.find("#qc_dc_cell");
		const elRun = panel.find("#qc_dc_run");
		const elStatus = panel.find("#qc_dc_status");
		const elSlider = panel.find("#qc_dc_threshold");
		const elThresholdLabel = panel.find("#qc_dc_threshold_lbl");
		const elLegend = panel.find("#qc_dc_legend");
		const elApply = panel.find("#qc_dc_apply");
		const elReset = panel.find("#qc_dc_reset");

		const setStatus = (text) => elStatus.html(text || "&nbsp;");

		let grid = null;
		let scanning = false;
		let abort = false;
		let activeRequests = null;
		let colouring = false;
		let savedMaterial = null;
		let updateHook = null;
		let threshold = 50;

		// ---- grid

		/**
		 * World-space XY footprint of the active cuts, so the grid can be sized to
		 * the area being analysed instead of the whole delivery. Returns null when
		 * the footprint cannot be bounded cheaply, in which case the caller falls
		 * back to the full cloud.
		 */
		function clipExtentXY(clip) {
			if (!clip || !clip.showInside) {
				return null;
			}

			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			const point = new ctx.Vector3();
			const add = () => {
				minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
				minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
			};

			for (const matrix of clip.boxMatrices || []) {
				for (let i = 0; i < 8; i++) {
					point.set(
						(i & 1) ? 0.5 : -0.5,
						(i & 2) ? 0.5 : -0.5,
						(i & 4) ? 0.5 : -0.5).applyMatrix4(matrix);
					add();
				}
			}

			for (const polygon of clip.polygons) {
				// A perspective capture sweeps out a frustum whose footprint depends on
				// depth, so there is no cheap xy bound - fall back to the whole cloud.
				if (polygon.projMatrix.elements[15] !== 1) {
					return null;
				}
				const inverse = polygon.projMatrix.clone()
					.multiply(polygon.viewMatrix).invert();
				for (const marker of polygon.markers) {
					point.set(marker.position.x, marker.position.y, 0).applyMatrix4(inverse);
					add();
				}
			}

			return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
		}

		function buildGrid(cell, extent) {
			const box = viewer.scene.getBoundingBox();
			if (!isFinite(box.min.x)) {
				return null;
			}

			// Union of the cuts, intersected with the cloud. Points outside fall
			// outside the grid and are ignored, which is correct: they are cut away.
			let lowX = box.min.x, lowY = box.min.y;
			let highX = box.max.x, highY = box.max.y;
			if (extent) {
				lowX = Math.max(lowX, extent.minX - cell);
				lowY = Math.max(lowY, extent.minY - cell);
				highX = Math.min(highX, extent.maxX + cell);
				highY = Math.min(highY, extent.maxY + cell);
			}
			if (!(highX > lowX) || !(highY > lowY)) {
				return null;
			}

			const originX = Math.floor(lowX / cell) * cell;
			const originY = Math.floor(lowY / cell) * cell;
			const nx = Math.ceil((highX - originX) / cell) + 1;
			const ny = Math.ceil((highY - originY) / cell) + 1;

			if (nx * ny > 40e6) {
				return { tooBig: true, nx: nx, ny: ny };
			}
			return {
				cell: cell, originX: originX, originY: originY,
				nx: nx, ny: ny, counts: new Float64Array(nx * ny),
			};
		}

		const cellIndex = (g, x, y) => {
			const ix = Math.floor((x - g.originX) / g.cell);
			const iy = Math.floor((y - g.originY) / g.cell);
			if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) {
				return -1;
			}
			return iy * g.nx + ix;
		};

		/**
		 * Walks a node's points in world space without allocating per point.
		 *
		 * Every point is visited - no subsampling. Taking every Nth point was tried
		 * and dropped: point order inside a node is a spatially structured scan
		 * pattern, so any index-based selection lands on a structured spatial subset
		 * rather than a random one. On a uniform 225 pts/m2 grid, 1-in-10 sampling
		 * reported cells from 160 to 420 pts/m2, both with a plain stride and with a
		 * hashed index. Sampling randomly in *space* would need the position of every
		 * point, which is the work being avoided. And it bought almost nothing: on a
		 * cold node cache the run took 796 ms against 766 ms for the exact scan,
		 * because the time goes into loading and decoding nodes, not this loop.
		 */
		function forEachPoint(pointcloud, node, visit) {
			const geometry = node.geometry;
			if (!geometry || !geometry.attributes.position) {
				return 0;
			}
			const array = geometry.attributes.position.array;
			const count = geometry.attributes.position.count;

			pointcloud.updateMatrixWorld(true);
			const min = node.boundingBox.min;
			const e = pointcloud.matrixWorld.elements;
			const ox = min.x, oy = min.y, oz = min.z;

			let visited = 0;
			for (let i = 0; i < count; i++) {
				const lx = array[3 * i + 0] + ox;
				const ly = array[3 * i + 1] + oy;
				const lz = array[3 * i + 2] + oz;
				visit(
					i,
					e[0] * lx + e[4] * ly + e[8] * lz + e[12],
					e[1] * lx + e[5] * ly + e[9] * lz + e[13],
					e[2] * lx + e[6] * ly + e[10] * lz + e[14]);
				visited++;
			}
			return visited;
		}

		// ---- streaming the points
		//
		// The scan runs on potree's own getPointsInProfile, the same API the density
		// probe uses. An earlier version drove node.load() directly to walk the
		// octree: it was faster on paper but it wedged potree's loader. Nodes
		// disposed mid-load keep their `loading` flag set, failed decodes never
		// reset it, and each one permanently holds one of the four global load
		// slots - so a second analysis did nothing and the rest of the cloud stopped
		// resolving past its coarsest level. Letting potree schedule the loading
		// removes that whole class of failure.
		//
		// A profile is an infinitely tall corridor along a line, so the area is
		// covered by parallel strips. potree gives all in-flight profile requests a
		// shared 5 ms per frame, so several strips at once is also what keeps the
		// throughput up - one request alone advances a single node per frame.

		const TARGET_STRIPS = 24;

		function scan(pointcloud, g, filter, extent, progress) {
			const box = viewer.scene.getBoundingBox();
			const minX = Math.max(box.min.x, extent ? extent.minX : -Infinity);
			const maxX = Math.min(box.max.x, extent ? extent.maxX : Infinity);
			const minY = Math.max(box.min.y, extent ? extent.minY : -Infinity);
			const maxY = Math.min(box.max.y, extent ? extent.maxY : Infinity);

			if (!(maxX > minX) || !(maxY > minY)) {
				return Promise.resolve({ counted: 0, strips: 0 });
			}

			const stripCount = Math.max(1, Math.min(
				TARGET_STRIPS, Math.ceil((maxY - minY) / g.cell)));
			const stripHeight = (maxY - minY) / stripCount;

			// Points exactly on a strip edge fail potree's strict `distance <
			// width/2` test and would be dropped by both neighbours. Overlap the
			// corridors slightly and decide ownership ourselves with a half-open
			// range, so every point is counted exactly once.
			const pad = Math.max(stripHeight * 1e-3, 1e-4);
			const offset = pointcloud.position;

			return new Promise((resolve) => {
				let counted = 0;
				let pending = stripCount;
				let finished = false;
				const requests = [];

				let lastProgress = performance.now();
				let watchdog = null;

				const done = () => {
					if (finished) {
						return;
					}
					finished = true;
					if (watchdog) {
						clearInterval(watchdog);
					}
					activeRequests = null;
					resolve({ counted: counted, strips: stripCount, stalled: pending > 0 });
				};

				const settle = () => {
					pending--;
					if (pending > 0) {
						return;
					}
					done();
				};

				// A request that never reaches onFinish would leave `scanning` set and
				// the tool dead for the rest of the session. Nothing should be able to
				// do that to the second analysis, whatever goes wrong in the first.
				watchdog = setInterval(() => {
					if (finished) {
						clearInterval(watchdog);
						return;
					}
					if (performance.now() - lastProgress < 30000) {
						return;
					}
					for (const request of requests) {
						try {
							request.cancel();
						} catch (e) {
							// already gone
						}
					}
					done();
				}, 2000);

				for (let i = 0; i < stripCount; i++) {
					const lowY = minY + i * stripHeight;
					const highY = lowY + stripHeight;
					const centreY = (lowY + highY) / 2;
					// Last strip owns its upper edge, so the top row is not lost.
					const isLast = i === stripCount - 1;

					const profile = new Potree.Profile();
					profile.width = stripHeight + 2 * pad;
					profile.points = [
						new ctx.Vector3(minX - pad, centreY, 0),
						new ctx.Vector3(maxX + pad, centreY, 0),
					];

					const request = pointcloud.getPointsInProfile(profile, null, {
						onProgress: (event) => {
							if (abort) {
								return;
							}
							for (const segment of event.points.segments) {
								const points = segment.points;
								const n = points.numPoints;
								const pos = points.data.position;
								if (n === 0 || !pos) {
									continue;
								}

								const accepts = filter.accepterFor(pointcloud,
									(name) => points.data[name]);

								for (let p = 0; p < n; p++) {
									const y = pos[3 * p + 1] + offset.y;
									if (y < lowY || (isLast ? y > highY : y >= highY)) {
										continue;   // owned by another strip
									}
									const x = pos[3 * p + 0] + offset.x;
									const z = pos[3 * p + 2] + offset.z;
									if (accepts && !accepts(p, x, y, z)) {
										continue;
									}
									const index = cellIndex(g, x, y);
									if (index >= 0) {
										g.counts[index]++;
										counted++;
									}
								}
							}
							lastProgress = performance.now();
							progress(counted, stripCount - pending);
						},
						onFinish: settle,
						onCancel: settle,
					});

					requests.push(request);
				}

				activeRequests = requests;
			});
		}
		async function analyse() {
			if (scanning) {
				// Stop: cancelling each request also removes it from the point
				// cloud's queue, so its onCancel settles the run.
				abort = true;
				for (const request of activeRequests || []) {
					try {
						request.cancel();
					} catch (e) {
						// already finished
					}
				}
				return;
			}
			if (viewer.scene.pointclouds.length === 0) {
				viewer.postMessage("Load a point cloud first.", { duration: 3000 });
				return;
			}

			const cell = Math.max(0.1, parseFloat(elCell.val()) || 1);
			const filter = createVisibilityFilter(ctx);
			const extent = clipExtentXY(filter.clipRule);
			const g = buildGrid(cell, extent);

			if (!g) {
				setStatus("No point cloud bounds available.");
				return;
			}
			if (g.tooBig) {
				setStatus(`A ${fmt(cell, 2)} m grid over this cloud needs ` +
					`${Potree.Utils.addCommas(g.nx * g.ny)} cells - use a larger cell size.`);
				return;
			}

			// Say plainly whether the cuts are narrowing the scan. Without this,
			// "it ignored my cut" and "my cut only removed a little" look identical
			// from the outside.
			let cutNote = "";
			const cutsExist = viewer.scene.volumes.some((v) => v.clip) ||
				viewer.scene.polygonClipVolumes.some((v) => v.initialized);
			if (cutsExist && !extent) {
				const taskName = Object.keys(Potree.ClipTask)
					.find((k) => Potree.ClipTask[k] === viewer.clipTask) || "?";
				cutNote = ` Cuts exist but the scanned area could not be narrowed ` +
					`(clip task is ${taskName}) - set Tools &gt; Clipping to Inside.`;
			} else if (!cutsExist) {
				cutNote = " No cut active, so the whole cloud was scanned.";
			}

			scanning = true;
			abort = false;
			elRun.val("Stop");


			const started = performance.now();
			let total = 0;
			let stripsTotal = 0;
			let stalledScan = false;
			try {
				for (const pointcloud of viewer.scene.pointclouds.slice()) {
					const result = await scan(pointcloud, g, filter, extent,
						(counted, done) => {
							setStatus(`Counted ${Potree.Utils.addCommas(counted)} points, ` +
								`${done} strips done&hellip;`);
						});
					total += result.counted;
					stripsTotal += result.strips;
					stalledScan = stalledScan || !!result.stalled;
					if (abort) {
						break;
					}
				}
			} finally {
				activeRequests = null;
				scanning = false;
				elRun.val("Analyse density");
			}

			if (abort) {
				setStatus("Stopped - the grid would be incomplete, so nothing was applied.");
				return;
			}

			const area = cell * cell;
			let max = 0;
			for (let i = 0; i < g.counts.length; i++) {
				const density = g.counts[i] / area;
				g.counts[i] = density;
				if (density > max) {
					max = density;
				}
			}
			g.max = max;
			g.filters = filter.labels;
			grid = g;

			const seconds = (performance.now() - started) / 1000;
			setStatus(`Done in ${fmt(seconds, 1)} s &mdash; ` +
				`${Potree.Utils.addCommas(total)} points counted over ${stripsTotal} strips. ` +
				`Peak ${fmt(max, 1)} pts/m&sup2;. ` +
				`Grid ${Potree.Utils.addCommas(g.nx * g.ny)} cells.${cutNote}`);

			configureSlider(max);
			elApply.prop("disabled", false);
			applyColouring();
		}

		// ---- colouring

		function configureSlider(max) {
			const top = Math.max(10, Math.ceil(max));
			threshold = Math.min(threshold, top);

			if (elSlider.hasClass("ui-slider")) {
				elSlider.slider("option", "max", top);
				elSlider.slider("value", threshold);
			} else {
				elSlider.slider({
					min: 0,
					max: top,
					value: threshold,
					step: 1,
					slide: (event, ui) => {
						threshold = ui.value;
						elThresholdLabel.text(fmt(threshold, 0));
						if (colouring) {
							updateRamp();
						}
					},
				});
			}
			elThresholdLabel.text(fmt(threshold, 0));
		}

		/**
		 * Solid red below the limit, then orange at it ramping to green. The hard
		 * step is the point: a cell one point under spec should not look "nearly
		 * fine", it should read as a failure.
		 */
		function thresholdGradient(limit, displayMax) {
			const Color = Potree.Gradients.RAINBOW[0][1].constructor;
			const t = Math.min(Math.max(limit / displayMax, 0.001), 0.999);

			return [
				[0.0, new Color(0.60, 0.02, 0.02)],
				[t * 0.999, new Color(0.85, 0.10, 0.08)],
				[t, new Color(1.00, 0.55, 0.05)],
				[t + (1 - t) * 0.5, new Color(0.85, 0.80, 0.10)],
				[1.0, new Color(0.10, 0.65, 0.15)],
			];
		}

		function attachDensity(pointcloud, geometryNode) {
			const geometry = geometryNode.geometry;
			if (!grid || !geometry || !geometry.attributes.position) {
				return false;
			}

			const existing = geometry.attributes[DENSITY_ATTRIBUTE];
			// Stamp with the grid identity, not just presence. Skipping on presence
			// alone meant a second analysis built a new grid that never reached the
			// GPU, so re-running on a different area appeared to do nothing.
			if (existing && geometry.qcDensityGrid === grid) {
				return false;
			}

			const count = geometry.attributes.position.count;
			const reuse = existing && existing.array.length === count;
			const values = reuse ? existing.array : new Float32Array(count);

			// A node that cannot overlap the analysed grid is uniformly zero, so skip
			// the per-point pass. That is the whole rest of the cloud once a cut is
			// removed, which is exactly when the work would otherwise pile up.
			pointcloud.updateMatrixWorld(true);
			const world = geometryNode.boundingBox.clone()
				.applyMatrix4(pointcloud.matrixWorld);
			const gridMaxX = grid.originX + grid.nx * grid.cell;
			const gridMaxY = grid.originY + grid.ny * grid.cell;
			const outside = world.max.x < grid.originX || world.min.x > gridMaxX ||
				world.max.y < grid.originY || world.min.y > gridMaxY;

			if (outside) {
				if (reuse) {
					values.fill(0);
				}
			} else {
				forEachPoint(pointcloud, geometryNode, (i, x, y) => {
					const index = cellIndex(grid, x, y);
					values[i] = index >= 0 ? grid.counts[index] : 0;
				});
			}

			if (reuse) {
				// Same buffer, new contents: bumping the version is what makes the
				// renderer re-upload it on the next frame.
				existing.version++;
			} else {
				// Just add it. The renderer used to throw on a geometry carrying an
				// attribute with no vbo, so this had to tear the whole buffer set down
				// and rebuild it - one GPU teardown per node, which is what wrecked
				// rendering once a cut was removed and hundreds of nodes arrived at
				// once. Renderer.updateBuffer now creates the missing vbo instead
				// (see the [QC Tools] guards in potree.js).
				geometry.setAttribute(DENSITY_ATTRIBUTE,
					new (geometry.attributes.position.constructor)(values, 1));
			}

			geometry.qcDensityGrid = grid;
			return true;
		}

		/**
		 * Density lives only on the node geometries, never in
		 * `pcoGeometry.pointAttributes`.
		 *
		 * That list is the point *format* description, and it is handed straight to
		 * the decoder worker. Registering a 4-byte attribute there made the worker
		 * expect four bytes per point that the file does not contain, so every node
		 * loaded after an analysis failed to decode with "Offset is outside the
		 * bounds of the DataView" - and a node that cannot decode is skipped for
		 * good. That is what left whole regions stuck at coarse level with oversized
		 * points, and what made a second analysis fail or crash.
		 *
		 * Measured: 0 decode failures after nine deep zooms with no tools, 0 straight
		 * after an analysis, then 24 as soon as navigation needed new nodes.
		 *
		 * The renderer reads the display range from material.setRange(), and its one
		 * lookup into pointAttributes is now guarded (see potree.js), so nothing has
		 * to be registered at all.
		 */
		function setDisplayRange(pointcloud, displayMax) {
			pointcloud.material.setRange(DENSITY_ATTRIBUTE, [0, displayMax]);
		}

		/** Gradient and range only - cheap enough to run while dragging the slider. */
		function updateRamp() {
			const displayMax = Math.max(threshold * 2, 1);

			for (const pointcloud of viewer.scene.pointclouds) {
				const material = pointcloud.material;
				setDisplayRange(pointcloud, displayMax);
				material.gradient = thresholdGradient(threshold, displayMax);
			}

			const filters = grid && grid.filters && grid.filters.length
				? ` Counted only visible points (${grid.filters.join(", ")}).`
				: "";

			elLegend.html(`
				<div class="qc-dim">Red below <b>${fmt(threshold, 0)}</b> pts/m&sup2;,
				orange at it, green from <b>${fmt(displayMax, 0)}</b> up.
				Cell ${grid ? fmt(grid.cell, 2) : "?"} m.${filters}</div>
			`);
		}

		function applyColouring() {
			if (!grid) {
				return;
			}

			for (const pointcloud of viewer.scene.pointclouds) {
				const material = pointcloud.material;
				if (!savedMaterial) {
					savedMaterial = {
						activeAttributeName: material.activeAttributeName,
						gradient: material.gradient,
					};
				}
			}

			updateRamp();

			for (const pointcloud of viewer.scene.pointclouds) {
				pointcloud.material.activeAttributeName = DENSITY_ATTRIBUTE;
			}

			colouring = true;
			elReset.prop("disabled", false);
			refreshLoadedNodes();

			if (!updateHook) {
				// Nodes stream in as you navigate, so newly loaded ones need the
				// attribute too or they would render with no density at all. Throttled
				// and capped - see refreshLoadedNodes.
				// Every frame, with a time budget rather than a node count. A node
				// that arrives uncoloured reads as zero density and paints red, so
				// while zooming, green ground flashed red until a throttled pass got
				// round to it. Colouring a node is now just a grid lookup per point -
				// the GPU buffer teardown that made this expensive is gone - so it can
				// keep up with streaming instead of lagging behind it.
				updateHook = () => {
					if (colouring) {
						refreshLoadedNodes(6);
					}
				};
				viewer.addEventListener("update", updateHook);
			}
		}

		/**
		 * Colours newly streamed-in nodes, a few at a time.
		 *
		 * This used to run over every visible node on every frame. Removing a cut
		 * makes hundreds of nodes appear at once, and each one costs a GPU buffer
		 * teardown plus a pass over all of its points - enough, on a large cloud, to
		 * bury the frame and stop the renderer ever refining past its coarse levels.
		 * Spreading the work keeps it off the critical path; a node or two lagging a
		 * frame behind is not noticeable.
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
					if (!attachDensity(pointcloud, geometryNode)) {
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

		function restore() {
			colouring = false;
			for (const pointcloud of viewer.scene.pointclouds) {
				const material = pointcloud.material;
				if (savedMaterial) {
					material.gradient = savedMaterial.gradient;
					material.activeAttributeName = savedMaterial.activeAttributeName;
				}
			}
			savedMaterial = null;
			elReset.prop("disabled", true);
			setStatus("Original colouring restored. The analysis is kept.");
		}

		configureSlider(100);

		elRun.click(analyse);
		elApply.click(applyColouring);
		elReset.click(restore);

		return {
			analyse: analyse,
			apply: applyColouring,
			restore: restore,
			setThreshold: (value) => {
				threshold = value;
				configureSlider(grid ? grid.max : 100);
				if (colouring) {
					updateRamp();
				}
			},
			densityAt: (x, y) => {
				if (!grid) {
					return null;
				}
				const index = cellIndex(grid, x, y);
				return index >= 0 ? grid.counts[index] : null;
			},
			get grid() { return grid; },
		};
	}
	// -------------------------------------------------------------- scan angle

	/**
	 * Colours a cloud by how far off nadir each point was measured, symmetrically,
	 * with a hard step at a chosen field of view.
	 *
	 * Symmetric because scan angle is signed and 0 is nadir, so -35 and +35 are
	 * equally oblique and should read alike. Potree cannot do that with its own
	 * controls: `getExtra()` clamps the gradient coordinate to 0..1 before the
	 * texture lookup, so the Gradient panel's "Mirrored Repeat" has nothing to act
	 * on. What works instead needs no shader change at all. Set the display range
	 * to +-max|angle| so nadir lands exactly on the middle of the gradient, then
	 * hand Potree a gradient that is itself a mirror about its midpoint.
	 *
	 * The hard step is the same idea as the density spec threshold: a point just
	 * outside the field of view you are willing to accept should read as outside,
	 * not as "nearly inside".
	 */
	function initScanAngle(ctx, panel) {
		const viewer = ctx.viewer;
		const ANGLE_UNITS = (window.QCAttrList && window.QCAttrList.angleUnits) || {};

		panel.append($(`
			<div class="divider"><span>Scan angle</span></div>
			<li>
				<span class="qc-row">
					<span>Field of view</span>
					<input id="qc_sa_fov" type="number" min="1" max="360" step="1" value="75" class="qc-num"/>
					<span>&deg; total</span>
				</span>
			</li>
			<li><div id="qc_sa_slider" class="qc-slider"></div></li>
			<li id="qc_sa_status" class="qc-status">&nbsp;</li>
			<li>
				<span class="qc-row">
					<input id="qc_sa_apply" type="button" value="Colour by scan angle"/>
					<span style="flex-grow: 1"></span>
					<input id="qc_sa_reset" type="button" value="Restore colours" disabled/>
				</span>
			</li>
			<li class="qc-dim">Green at nadir through amber at the limit, red beyond
				it. Both sides of the scan line are coloured alike.</li>
		`));

		const elFov = panel.find("#qc_sa_fov");
		const elSlider = panel.find("#qc_sa_slider");
		const elStatus = panel.find("#qc_sa_status");
		const elApply = panel.find("#qc_sa_apply");
		const elReset = panel.find("#qc_sa_reset");

		const setStatus = (text) => elStatus.html(text || "&nbsp;");

		let fov = 75;
		let colouring = false;
		let saved = null;

		/** The scan angle attribute of a cloud, whichever of the two names it uses. */
		function angleAttribute(pointcloud) {
			for (const name of Object.keys(ANGLE_UNITS)) {
				const attribute = pointcloud.getAttribute && pointcloud.getAttribute(name);
				if (attribute && attribute.range) {
					return { name: name, attribute: attribute, perUnit: ANGLE_UNITS[name] };
				}
			}
			return null;
		}

		/** Every loaded cloud that records a scan angle at all. */
		function targets() {
			const found = [];
			for (const pointcloud of viewer.scene.pointclouds) {
				const found1 = angleAttribute(pointcloud);
				if (found1) {
					found.push({ pointcloud: pointcloud, ...found1 });
				}
			}
			return found;
		}

		/** Widest angle the cloud actually records, in degrees, either side of nadir. */
		function extentDegrees(target) {
			const range = target.attribute.initialRange || target.attribute.range;
			return Math.max(Math.abs(range[0]), Math.abs(range[1])) * target.perUnit;
		}

		/**
		 * A gradient mirrored about its own midpoint, so that a display range of
		 * -extent..+extent paints -X and +X identically. `limit` is the half angle
		 * beyond which a point is out of spec.
		 */
		function symmetricGradient(limit, extent) {
			const Color = Potree.Gradients.RAINBOW[0][1].constructor;
			const red = () => new Color(0.75, 0.06, 0.06);
			const amber = () => new Color(1.00, 0.62, 0.05);
			const green = () => new Color(0.10, 0.68, 0.16);

			// Half the accepted band as a fraction of the whole gradient.
			const half = Math.min(limit / (2 * extent), 0.499);

			if (limit >= extent) {
				// Nothing is out of spec, so there is no step to draw.
				return [[0.0, amber()], [0.5, green()], [1.0, amber()]];
			}

			const lo = 0.5 - half;
			const hi = 0.5 + half;

			return [
				[0.0, red()],
				[Math.max(lo - 0.002, 0.001), red()],
				[lo, amber()],
				[0.5, green()],
				[hi, amber()],
				[Math.min(hi + 0.002, 0.999), red()],
				[1.0, red()],
			];
		}

		function paint() {
			const list = targets();
			if (list.length === 0) {
				return;
			}

			for (const target of list) {
				const extent = extentDegrees(target);
				const material = target.pointcloud.material;

				// Symmetric about nadir, so 0 degrees falls exactly on the middle of
				// the gradient. Without this the file's own lopsided range (say
				// -39.81 to +40.49) puts nadir off centre and the mirror is wrong.
				material.setRange(target.name,
					[-extent / target.perUnit, extent / target.perUnit]);
				material.gradient = symmetricGradient(fov / 2, extent);
				material.activeAttributeName = target.name;
			}

			const widest = Math.max(...list.map(extentDegrees));
			const outside = fov / 2 < widest;
			setStatus(`Coloured by scan angle. The data reaches &plusmn;${widest.toFixed(1)}&deg;; `
				+ (outside
					? `red beyond &plusmn;${(fov / 2).toFixed(1)}&deg;.`
					: `nothing falls outside a ${fov.toFixed(0)}&deg; field of view.`));
		}

		function apply() {
			const list = targets();
			if (list.length === 0) {
				setStatus("No loaded cloud records a scan angle.");
				return;
			}

			if (!saved) {
				saved = list.map((target) => ({
					pointcloud: target.pointcloud,
					activeAttributeName: target.pointcloud.material.activeAttributeName,
					gradient: target.pointcloud.material.gradient,
					range: target.pointcloud.material.getRange(target.name),
					name: target.name,
				}));
			}

			colouring = true;
			elReset.prop("disabled", false);
			paint();
		}

		function restore() {
			colouring = false;
			for (const entry of saved || []) {
				const material = entry.pointcloud.material;
				material.gradient = entry.gradient;
				if (entry.range) {
					material.setRange(entry.name, entry.range);
				}
				material.activeAttributeName = entry.activeAttributeName;
			}
			saved = null;
			elReset.prop("disabled", true);
			setStatus("Original colouring restored.");
		}

		function setFov(value) {
			fov = Math.min(Math.max(value, 1), 360);
			elFov.val(fov);
			elSlider.slider({ value: fov });
			if (colouring) {
				paint();
			}
		}

		elSlider.slider({
			value: fov, min: 1, max: 180, step: 1,
			slide: (event, ui) => setFov(ui.value),
		});
		elFov.on("change", () => setFov(Number(elFov.val()) || 75));
		elApply.click(apply);
		elReset.click(restore);

		return {
			apply: apply,
			restore: restore,
			setFov: setFov,
			get fov() { return fov; },
			extents: () => targets().map((t) => ({ name: t.name, degrees: extentDegrees(t) })),
		};
	}

	// ------------------------------------------------------------ cut settings

	function initCutSettings(panel, clipMode) {
		panel.append($(`
			<div class="divider"><span>Cut settings</span></div>
			<li><label><input id="qc_cut_invert" type="checkbox"/>
				Invert - keep what is outside the cuts</label></li>
			<li class="qc-dim">Two or more cuts are intersected: a point has to be
				inside all of them to survive.</li>
		`));

		panel.find("#qc_cut_invert").click(function () {
			clipMode.setInvert($(this).prop("checked"));
		});
	}

	window.QCTools = {
		install: install,
		getClipBounds: () => null,
	};
})();
