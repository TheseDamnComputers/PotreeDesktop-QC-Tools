/**
 * QC Tools: basemap under the cloud's footprint.
 *
 * Potree already ships a working 2D map: OpenLayers 3 is bundled, `MapView`
 * draws the cloud extent and the camera frustum on it, and the toolbar has a
 * toggle. None of it ever appears, for one reason: the map only switches on when
 * `pointcloud.projection` is set, that comes from `metadata.json`, and
 * PotreeConverter only writes the field when it is given `--projection`. A
 * converted delivery therefore has no CRS and the whole feature stays dark.
 *
 * The source LAS/LAZ does carry one, and File info already reads it back through
 * `qc_source.json`. Handing it to Potree is all it takes.
 *
 * On top of that this adds what Potree has no notion of: a choice of basemap, and
 * a choice between streaming tiles as you navigate and caching them on disk
 * first. Streaming asks the tile server for a tile every time you move, which
 * both needs a live connection and tells that server which patch of ground you
 * are looking at. A local cache is fetched once and then works offline.
 *
 * Plain script, loaded after potree.js. QCTools.install(viewer) calls install().
 */
(function () {
	"use strict";

	// Web Mercator half-circumference, the constant the whole slippy-map tile
	// scheme is built on.
	const MERCATOR_EDGE = 20037508.342789244;

	/**
	 * Basemaps, as XYZ templates. `bulk` says whether fetching a whole area at
	 * once is acceptable to the provider, which is a licensing question rather
	 * than a technical one: OpenStreetMap's tile policy asks that you not bulk
	 * download from their servers, so that one is stream only.
	 */
	const PROVIDERS = [
		{
			id: "esri-imagery",
			group: "Aerial and satellite",
			name: "Esri world imagery",
			url: "https://server.arcgisonline.com/ArcGIS/rest/services/"
				+ "World_Imagery/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 19,
			bulk: true,
		},
		{
			id: "usgs-imagery",
			group: "Aerial and satellite",
			name: "USGS imagery, US only",
			url: "https://basemap.nationalmap.gov/arcgis/rest/services/"
				+ "USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 16,
			bulk: true,
			note: "public domain, but United States coverage only, and it stops "
				+ "at zoom 16",
		},
		{
			id: "s2cloudless",
			group: "Aerial and satellite",
			name: "Sentinel-2 cloudless, 10 m",
			url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/"
				+ "default/GoogleMapsCompatible/{z}/{y}/{x}.jpg",
			extension: "jpg",
			maxZoom: 15,
			bulk: true,
			note: "10 m pixels, so past zoom 14 it is upsampled rather than "
				+ "sharper. EOX, CC BY-NC-SA: check the licence before "
				+ "commercial use",
		},
		{
			id: "esri-topo",
			group: "Maps",
			name: "Esri world topographic",
			url: "https://server.arcgisonline.com/ArcGIS/rest/services/"
				+ "World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 19,
			bulk: true,
		},
		{
			id: "esri-street",
			group: "Maps",
			name: "Esri world street map",
			url: "https://server.arcgisonline.com/ArcGIS/rest/services/"
				+ "World_Street_Map/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 19,
			bulk: true,
		},
		{
			id: "usgs-topo",
			group: "Maps",
			name: "USGS topographic, US only",
			url: "https://basemap.nationalmap.gov/arcgis/rest/services/"
				+ "USGSTopo/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 16,
			bulk: true,
			note: "public domain, United States coverage only",
		},
		{
			id: "usgs-imagery-topo",
			group: "Maps",
			name: "USGS imagery with topo, US only",
			url: "https://basemap.nationalmap.gov/arcgis/rest/services/"
				+ "USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 16,
			bulk: true,
			note: "public domain, United States coverage only",
		},
		{
			id: "osm",
			group: "Maps",
			name: "OpenStreetMap",
			url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
			extension: "png",
			maxZoom: 19,
			bulk: false,
			note: "streaming only: the OSM tile policy asks that you not bulk download",
		},
		{
			id: "opentopomap",
			group: "Maps",
			name: "OpenTopoMap",
			url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
			extension: "png",
			maxZoom: 17,
			bulk: false,
			note: "streaming only: its tile policy follows OSM's",
		},
		{
			id: "carto-light",
			group: "Maps",
			name: "Carto Positron, pale",
			url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
			extension: "png",
			maxZoom: 20,
			bulk: false,
			note: "streaming only, and it needs Carto and OSM attribution. Pale "
				+ "enough to read a cloud against",
		},
		{
			id: "carto-dark",
			group: "Maps",
			name: "Carto Dark Matter",
			url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
			extension: "png",
			maxZoom: 20,
			bulk: false,
			note: "streaming only, and it needs Carto and OSM attribution. Dark "
				+ "enough to read a bright cloud against",
		},
		{
			id: "esri-hillshade",
			group: "Terrain and national",
			name: "Esri world hillshade",
			url: "https://server.arcgisonline.com/ArcGIS/rest/services/"
				+ "Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
			extension: "jpg",
			maxZoom: 16,
			bulk: true,
			note: "shaded relief with no labels, which is the one that makes "
				+ "landform legible under a cloud",
		},
		{
			id: "kartverket-topo",
			group: "Terrain and national",
			name: "Kartverket topo, Norway",
			url: "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/"
				+ "webmercator/{z}/{y}/{x}.png",
			extension: "png",
			maxZoom: 18,
			bulk: true,
			note: "Norway only. Kartverket open data, attribution required",
		},
		{
			id: "custom",
			group: "Custom",
			name: "Custom XYZ template",
			url: "",
			extension: "png",
			maxZoom: 22,
			bulk: true,
			note: "put your own {z}/{x}/{y} template in, with any key it needs",
		},
	];

	/**
	 * Layers drawn *over* the basemap rather than instead of it.
	 *
	 * These are transparent PNG tile sets, so they compose: aerial imagery with
	 * place names on top reads far better than either alone, and a delivery along
	 * a rail corridor is much easier to place against the railway layer than
	 * against roads. They go through exactly the same fetch, cache and sentinel
	 * machinery as a basemap, so an overlay is one more table entry too.
	 */
	const OVERLAYS = [
		{
			id: "none",
			name: "none",
		},
		{
			id: "esri-labels",
			name: "Esri boundaries and place names",
			url: "https://server.arcgisonline.com/ArcGIS/rest/services/"
				+ "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
			extension: "png",
			maxZoom: 19,
			bulk: true,
		},
		{
			id: "esri-transport",
			name: "Esri roads and transport",
			url: "https://server.arcgisonline.com/ArcGIS/rest/services/"
				+ "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
			extension: "png",
			maxZoom: 19,
			bulk: true,
		},
		{
			id: "openrailwaymap",
			name: "OpenRailwayMap",
			url: "https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png",
			extension: "png",
			maxZoom: 19,
			bulk: false,
			note: "streaming only: its tile policy follows OSM's",
		},
	];

	// One sentinel template for the layer, so the tile loader always sees the
	// same shape and can decide stream-or-disk itself. Letting OpenLayers build
	// the real URL instead would mean parsing coordinates back out of it, and
	// OL3's tile coordinates are TMS-flipped, which is a good way to cache every
	// tile upside down.
	const SENTINEL = "qctile://{z}/{x}/{y}";
	const SENTINEL_RE = /^qctile:\/\/(\d+)\/(-?\d+)\/(-?\d+)$/;

	/**
	 * OpenStreetMap returns 403 "Access blocked" to Chromium's default Electron
	 * user agent: their tile policy requires a request that identifies the
	 * application. `fetch` cannot set User-Agent, it is a forbidden header, so
	 * tiles go out through node's https instead, which has no such restriction
	 * and no CORS to satisfy either.
	 */
	const USER_AGENT = "PotreeDesktop-QC-Tools/1.2 (+https://github.com/"
		+ "TheseDamnComputers/PotreeDesktop-QC-Tools)";

	/** Fetches one tile as a Buffer, or null. Follows redirects, which Esri uses. */
	function fetchTile(url, hops) {
		return new Promise((resolve) => {
			let request;
			try {
				const client = require(url.startsWith("http://") ? "http" : "https");
				request = client.get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
					if (response.statusCode >= 300 && response.statusCode < 400
							&& response.headers.location && (hops || 0) < 4) {
						response.resume();
						resolve(fetchTile(response.headers.location, (hops || 0) + 1));
						return;
					}
					if (response.statusCode !== 200) {
						response.resume();
						resolve(null);
						return;
					}
					const chunks = [];
					response.on("data", (chunk) => chunks.push(chunk));
					response.on("end", () => resolve(Buffer.concat(chunks)));
					response.on("error", () => resolve(null));
				});
			} catch (e) {
				resolve(null);
				return;
			}
			request.on("error", () => resolve(null));
			request.setTimeout(15000, () => { request.destroy(); resolve(null); });
		});
	}

	const CACHE_DIR = "qc_tiles";
	const PARALLEL = 5;

	/**
	 * A CRS string proj4 can actually build a transform from, or null.
	 *
	 * Two things make this necessary, and both are ordinary in real deliveries:
	 *
	 * A survey usually declares a **compound** system, horizontal plus vertical,
	 * as COMPD_CS[..., PROJCS[...], VERT_CS[...]]. proj4 cannot parse COMPD_CS and
	 * does not fail politely: it throws the whole WKT string as the exception,
	 * with no stack and no Error wrapper. Only the horizontal half means anything
	 * to a 2D basemap, so it is lifted out.
	 *
	 * And proj4 ships almost no EPSG table, so `proj4("EPSG:3006")` throws even
	 * though the code is perfectly valid. Whatever survives has to be tried before
	 * it is trusted, which is what the parse below is for. Setting
	 * `pointcloud.projection` to something proj4 rejects takes the viewer down:
	 * Potree calls into proj4 from its render path, the bare string escapes as an
	 * uncaught error, and the cloud renders zero nodes.
	 */
	function usableProjection(wkt) {
		if (!wkt || typeof wkt !== "string") {
			return null;
		}

		let candidate = wkt.trim();

		if (/^COMPD_CS/i.test(candidate)) {
			const inner = extractNode(candidate, "PROJCS") || extractNode(candidate, "GEOGCS");
			if (!inner) {
				return null;
			}
			candidate = inner;
		}

		try {
			// Building the transform is the only honest test. proj4 accepts the
			// string at construction and fails later otherwise.
			const transform = proj4(candidate, "EPSG:3857");
			const probe = transform.forward([0, 0]);
			if (!probe || !Number.isFinite(probe[0]) || !Number.isFinite(probe[1])) {
				return null;
			}
			return candidate;
		} catch (e) {
			return null;
		}
	}

	/** The balanced NAME[...] substring, quotes respected. */
	function extractNode(wkt, name) {
		const start = wkt.indexOf(name + "[");
		if (start < 0) {
			return null;
		}

		let depth = 0;
		let quoted = false;
		for (let i = start; i < wkt.length; i++) {
			const ch = wkt[i];
			if (ch === '"') {
				quoted = !quoted;
			} else if (!quoted && ch === "[") {
				depth++;
			} else if (!quoted && ch === "]") {
				depth--;
				if (depth === 0) {
					return wkt.slice(start, i + 1);
				}
			}
		}
		return null;
	}

	let installed = false;

	function install(ctx, panel) {
		if (installed) {
			return null;
		}
		installed = true;

		const viewer = ctx.viewer;
		const state = {
			provider: PROVIDERS[0],
			overlay: OVERLAYS[0],
			overlayLayer: null,
			overlayOpacity: 1,
			customUrl: "",
			local: false,
			padding: 500,
			maxZoom: 17,
			downloading: false,
			abort: false,
			cacheRoot: null,
		};

		const ui = buildPanel(panel);
		wireProjection(viewer, ui.setStatus);

		// ------------------------------------------------------------ tile maths

		// The tile helpers are written against *a* provider rather than against
		// the selected basemap, because an overlay is a provider too: same
		// template substitution, same fetch, same cache tree keyed by id. The
		// thin tileUrl/cachePath wrappers keep the basemap call sites, and the
		// exported API that qc_map3d and qc_imagery use, unchanged.
		const urlFor = (provider, z, x, y) => {
			const template = provider.id === "custom" ? state.customUrl : provider.url;
			return template
				.replace("{z}", z).replace("{x}", x).replace("{y}", y);
		};

		const pathFor = (provider, z, x, y) => {
			const npath = require("path");
			return npath.join(state.cacheRoot, CACHE_DIR, provider.id,
				String(z), String(x), `${y}.${provider.extension}`);
		};

		const tileUrl = (z, x, y) => urlFor(state.provider, z, x, y);
		const cachePath = (z, x, y) => pathFor(state.provider, z, x, y);

		/**
		 * The tile range covering the cloud, padded outwards. Potree gives us the
		 * extent already in Web Mercator, which is the tile scheme's own frame, so
		 * this needs no reprojection.
		 */
		const tileRange = (z, padding) => {
			const extent = viewer.mapView.getMapExtent();
			const xs = [extent.bottomLeft[0], extent.topRight[0]];
			const ys = [extent.bottomLeft[1], extent.topRight[1]];

			// Padding is asked for in metres on the ground; Web Mercator stretches
			// by 1/cos(latitude), so the same number of map units is less ground
			// the further from the equator. Correcting keeps "500 m" honest.
			const midY = (ys[0] + ys[1]) / 2;
			const latitude = 2 * Math.atan(Math.exp(midY / (MERCATOR_EDGE / Math.PI)))
				- Math.PI / 2;
			const pad = padding / Math.max(Math.cos(latitude), 1e-6);

			const toX = (mx) => (mx + MERCATOR_EDGE) / (2 * MERCATOR_EDGE) * Math.pow(2, z);
			const toY = (my) => (MERCATOR_EDGE - my) / (2 * MERCATOR_EDGE) * Math.pow(2, z);

			return {
				minX: Math.floor(toX(Math.min(...xs) - pad)),
				maxX: Math.floor(toX(Math.max(...xs) + pad)),
				minY: Math.floor(toY(Math.max(...ys) + pad)),
				maxY: Math.floor(toY(Math.min(...ys) - pad)),
			};
		};

		const countTiles = (padding, maxZoom) => {
			let total = 0;
			const perZoom = [];
			for (let z = 1; z <= maxZoom; z++) {
				const r = tileRange(z, padding);
				const n = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
				perZoom.push({ z: z, n: n });
				total += n;
			}
			return { total: total, perZoom: perZoom };
		};

		// ------------------------------------------------------------- the layer

		/**
		 * The deepest zoom actually present in the cache, or null.
		 *
		 * Local mode needs this. Without it the source happily asks for zoom 18
		 * over a cache that stops at 14, every tile misses, and the map goes blank
		 * the moment you look closely - which reads as broken rather than as "not
		 * downloaded that far". Capping the source instead makes OpenLayers
		 * upsample the deepest level it has, so you get a coarse picture rather
		 * than none.
		 */
		function deepestCachedZoom(provider) {
			if (!state.cacheRoot) {
				return null;
			}
			try {
				const fs = require("fs");
				const npath = require("path");
				const dir = npath.join(state.cacheRoot, CACHE_DIR,
					(provider || state.provider).id);
				const levels = fs.readdirSync(dir)
					.map(Number)
					.filter((n) => Number.isFinite(n));
				return levels.length ? Math.max(...levels) : null;
			} catch (e) {
				return null;
			}
		}

		/**
		 * A tile source for one provider, streaming or off the cache.
		 *
		 * Both the basemap and the overlay use this, which is the whole reason it
		 * takes a provider: two sources differ only in which table entry they
		 * close over.
		 */
		function makeSource(provider) {
			const cached = state.local ? deepestCachedZoom(provider) : null;

			return new ol.source.XYZ({
				url: SENTINEL,
				maxZoom: cached !== null ? cached : provider.maxZoom,
				crossOrigin: "anonymous",
				tileLoadFunction: (tile, src) => {
					const parsed = SENTINEL_RE.exec(src);
					const image = tile.getImage();
					if (!parsed) {
						return;
					}

					const z = Number(parsed[1]);
					const x = Number(parsed[2]);
					const y = Number(parsed[3]);

					if (!state.local) {
						image.src = urlFor(provider, z, x, y);
						return;
					}

					// Cached: hand the file straight to the <img>. A miss is left
					// blank rather than quietly fetched, so "local" means local and
					// a gap in the cache is visible instead of silently filled over
					// the network.
					if (!state.cacheRoot) {
						return;
					}
					const file = pathFor(provider, z, x, y);
					if (require("fs").existsSync(file)) {
						image.src = "file:///" + file.replace(/\\/g, "/");
					}
				},
			});
		}

		/** Swaps the base layer's source. Layer 0 is Potree's own OSM tile layer. */
		function applySource() {
			if (!viewer.mapView || !viewer.mapView.map) {
				return;
			}

			viewer.mapView.map.getLayers().item(0).setSource(makeSource(state.provider));
			applyOverlay();
		}

		/**
		 * The overlay layer, drawn on top of the basemap.
		 *
		 * It goes in at index 1, straight above the basemap and below everything
		 * else. Potree's own layers - the extent outline, the camera frustum, the
		 * source tiles - are all above it in that array, and an overlay that hid
		 * the outline it is meant to give context to would be worse than none.
		 *
		 * The layer is made once and kept, with only its source swapped, so
		 * changing overlay repeatedly cannot stack layers up in the map.
		 */
		function applyOverlay() {
			if (!viewer.mapView || !viewer.mapView.map) {
				return;
			}

			const layers = viewer.mapView.map.getLayers();

			if (!state.overlay || !state.overlay.url) {
				if (state.overlayLayer) {
					layers.remove(state.overlayLayer);
					state.overlayLayer = null;
				}
				return;
			}

			if (!state.overlayLayer) {
				state.overlayLayer = new ol.layer.Tile({ source: null });
				layers.insertAt(1, state.overlayLayer);
			}
			state.overlayLayer.setSource(makeSource(state.overlay));
			state.overlayLayer.setOpacity(state.overlayOpacity);
		}

		// ---------------------------------------------------------- the download

		async function download() {
			if (state.downloading) {
				state.abort = true;
				return;
			}
			if (!viewer.mapView || !viewer.mapView.sceneProjection) {
				ui.setStatus("No coordinate system, so there is nowhere to fetch.");
				return;
			}
			if (state.provider.id === "custom" && !state.customUrl) {
				ui.setStatus("Fill in a tile URL template first.");
				return;
			}
			if (!state.provider.bulk) {
				ui.setStatus(`${state.provider.name} is streaming only. `
					+ (state.provider.note || ""));
				return;
			}
			if (!state.cacheRoot) {
				ui.setStatus("No cloud loaded from disk, so there is nowhere to save.");
				return;
			}

			const fs = require("fs");
			const npath = require("path");

			state.downloading = true;
			state.abort = false;
			ui.elDownload.val("Cancel");

			let done = 0;
			let failed = 0;
			let skipped = 0;

			// A selected overlay is downloaded alongside the basemap. Without it,
			// local mode showed the cached basemap with the overlay missing, which
			// reads as the overlay being broken rather than as not downloaded. An
			// overlay whose provider is streaming-only is skipped, and said so.
			const toFetch = [state.provider];
			if (state.overlay && state.overlay.url) {
				if (state.overlay.bulk) {
					toFetch.push(state.overlay);
				} else {
					ui.setStatus(`${state.overlay.name} is streaming only, so only the `
						+ `basemap is being cached.`);
				}
			}

			const jobs = [];
			for (const layer of toFetch) {
				for (let z = 1; z <= Math.min(state.maxZoom, layer.maxZoom); z++) {
					const r = tileRange(z, state.padding);
					for (let x = r.minX; x <= r.maxX; x++) {
						for (let y = r.minY; y <= r.maxY; y++) {
							jobs.push([layer, z, x, y]);
						}
					}
				}
			}

			const fetchOne = async ([layer, z, x, y]) => {
				const file = pathFor(layer, z, x, y);
				if (fs.existsSync(file)) {
					skipped++;
					return;
				}
				try {
					const buffer = await fetchTile(urlFor(layer, z, x, y));
					if (!buffer) {
						failed++;
						return;
					}
					fs.mkdirSync(npath.dirname(file), { recursive: true });
					fs.writeFileSync(file, buffer);
				} catch (e) {
					failed++;
				}
			};

			// A small fixed pool. Tile servers rate-limit, and hammering one is
			// both rude and the fastest way to get an address blocked.
			let next = 0;
			const workers = Array.from({ length: PARALLEL }, async () => {
				while (next < jobs.length && !state.abort) {
					const job = jobs[next++];
					await fetchOne(job);
					done++;
					if (done % 25 === 0 || done === jobs.length) {
						ui.setStatus(`Downloading ${done} of ${jobs.length} tiles`
							+ `${failed ? `, ${failed} failed` : ""}`
							+ `${skipped ? `, ${skipped} already cached` : ""}.`);
						await new Promise((r) => setTimeout(r, 0));
					}
				}
			});
			await Promise.all(workers);

			state.downloading = false;
			ui.elDownload.val("Download tiles");
			// Re-source: in local mode the cache just got deeper, so the zoom cap
			// this was built with is now stale.
			applySource();
			ui.setStatus((state.abort
				? `Stopped. ${done - failed} tiles cached, ${jobs.length - done} not fetched. `
				: `Cached ${jobs.length - failed - skipped} tiles`
					+ `${skipped ? `, ${skipped} already there` : ""}`
					+ `${failed ? `, ${failed} failed` : ""}. `)
				+ describeState());
		}

		// ---------------------------------------------------------------- the UI

		/**
		 * The basemap list, grouped. Thirteen flat entries is a wall; the groups
		 * are what make "is there aerial for this area" answerable at a glance.
		 */
		function providerOptions() {
			const groups = [];
			for (const provider of PROVIDERS) {
				let group = groups.find((g) => g.name === provider.group);
				if (!group) {
					group = { name: provider.group, items: [] };
					groups.push(group);
				}
				group.items.push(provider);
			}
			return groups.map((group) => `<optgroup label="${group.name}">`
				+ group.items.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")
				+ `</optgroup>`).join("");
		}

		function buildPanel(panel) {
			panel.append($(`
				<div class="divider"><span>Map</span></div>
				<li>
					<label class="qc-axis" for="qc_map_provider">Basemap</label>
					<select id="qc_map_provider" style="width: 100%">
						${providerOptions()}
					</select>
				</li>
				<li>
					<!-- min-width: 0 on the select is load-bearing. A flex item
					     defaults to min-width: auto, so a select refuses to shrink
					     below its longest option name and pushes the opacity box
					     off the right edge of the sidebar, where it cannot be
					     clicked. Nothing in the panel's own numbers shows this. -->
					<span class="qc-row">
						<label for="qc_map_overlay">Overlay</label>
						<select id="qc_map_overlay" style="flex: 1 1 0; min-width: 0">
							${OVERLAYS.map((o) =>
								`<option value="${o.id}">${o.name}</option>`).join("")}
						</select>
						<input id="qc_map_overlay_opacity" type="number" min="10" max="100"
							step="10" value="100" class="qc-num" title="overlay opacity, percent"/>
						<span>%</span>
					</span>
				</li>
				<li id="qc_map_custom_row" style="display: none">
					<input id="qc_map_custom" type="text" style="width: 100%"
						placeholder="https://example.com/tiles/{z}/{x}/{y}.png"/>
				</li>
				<li>
					<span class="qc-row">
						<input id="qc_map_stream" type="button" value="Stream"/>
						<input id="qc_map_local" type="button" value="Local cache"/>
						<span style="flex-grow: 1"></span>
						<input id="qc_map_show" type="button" value="Show map"/>
					</span>
				</li>
				<li>
					<span class="qc-row">
						<span>Pad</span>
						<input id="qc_map_pad" type="number" min="0" step="100" value="500" class="qc-num"/>
						<span>m</span>
						<span style="flex-grow: 1"></span>
						<span>to zoom</span>
						<input id="qc_map_zoom" type="number" min="1" max="22" value="17" class="qc-num"/>
					</span>
				</li>
				<li><input id="qc_map_download" type="button" value="Download tiles" style="width: 100%"/></li>
				<li id="qc_map_status" class="qc-status">&nbsp;</li>
			`));

			const elStatus = panel.find("#qc_map_status");
			return {
				elDownload: panel.find("#qc_map_download"),
				elProvider: panel.find("#qc_map_provider"),
				elOverlay: panel.find("#qc_map_overlay"),
				elOverlayOpacity: panel.find("#qc_map_overlay_opacity"),
				elCustomRow: panel.find("#qc_map_custom_row"),
				elCustom: panel.find("#qc_map_custom"),
				elStream: panel.find("#qc_map_stream"),
				elLocal: panel.find("#qc_map_local"),
				elShow: panel.find("#qc_map_show"),
				elPad: panel.find("#qc_map_pad"),
				elZoom: panel.find("#qc_map_zoom"),
				setStatus: (text) => elStatus.html(text || "&nbsp;"),
			};
		}

		/**
		 * One place that describes mode, provider and cache together.
		 *
		 * Each handler used to write its own line, so the *combination* was never
		 * reported: switching basemap while in local mode showed the new
		 * provider's note while the map went blank, because nothing was cached for
		 * it. The blank was correct and the message was about something else.
		 */
		const describeState = () => {
			const overlay = state.overlay && state.overlay.url
				? ` Overlay: ${state.overlay.name}`
					+ (state.overlay.note ? ` (${state.overlay.note})` : "") + `.`
				: "";

			if (!state.local) {
				return `Streaming ${state.provider.name} as you navigate.`
					+ (state.provider.note ? ` Note: ${state.provider.note}.` : "")
					+ overlay;
			}
			if (!state.cacheRoot) {
				return "Local cache: no cloud loaded from disk, so there is nothing to read.";
			}
			const cached = deepestCachedZoom();
			if (cached === null) {
				return `Local cache: nothing downloaded for ${state.provider.name}, so the `
					+ `map is blank. Press Download tiles, or switch back to Stream.` + overlay;
			}
			return `Local cache: ${state.provider.name}, deepest zoom ${cached}. `
				+ `Closer than that is upsampled, not fetched.` + overlay;
		};

		const markMode = () => {
			ui.elStream.css("font-weight", state.local ? "normal" : "bold");
			ui.elLocal.css("font-weight", state.local ? "bold" : "normal");
		};

		ui.elProvider.on("change", function () {
			state.provider = PROVIDERS.find((p) => p.id === $(this).val());
			ui.elCustomRow.toggle(state.provider.id === "custom");
			ui.elZoom.attr("max", state.provider.maxZoom);
			// A provider with a shallower ceiling than the current setting would
			// otherwise leave the box reading a zoom that can never be fetched, and
			// the download silently stopping short of it.
			if (state.maxZoom > state.provider.maxZoom) {
				state.maxZoom = state.provider.maxZoom;
				ui.elZoom.val(state.maxZoom);
			}
			applySource();
			ui.setStatus(describeState());
		});
		ui.elOverlay.on("change", function () {
			state.overlay = OVERLAYS.find((o) => o.id === $(this).val()) || OVERLAYS[0];
			applyOverlay();
			ui.setStatus(describeState());
		});
		ui.elOverlayOpacity.on("change", function () {
			const percent = Math.min(100, Math.max(10, Number($(this).val()) || 100));
			$(this).val(percent);
			state.overlayOpacity = percent / 100;
			if (state.overlayLayer) {
				state.overlayLayer.setOpacity(state.overlayOpacity);
			}
		});
		ui.elCustom.on("change", function () {
			state.customUrl = $(this).val().trim();
			applySource();
		});
		ui.elStream.click(() => {
			state.local = false; markMode(); applySource(); ui.setStatus(describeState());
		});
		ui.elLocal.click(() => {
			state.local = true; markMode(); applySource(); ui.setStatus(describeState());
		});
		ui.elShow.click(() => viewer.toggleMap());
		ui.elPad.on("change", function () {
			state.padding = Math.max(0, Number($(this).val()) || 0);
		});
		ui.elZoom.on("change", function () {
			state.maxZoom = Math.min(state.provider.maxZoom,
				Math.max(1, Number($(this).val()) || 1));
			$(this).val(state.maxZoom);
			if (viewer.mapView && viewer.mapView.sceneProjection) {
				const plan = countTiles(state.padding, state.maxZoom);
				const both = state.overlay && state.overlay.url && state.overlay.bulk;
				ui.setStatus(`A download would fetch about `
					+ `${plan.total.toLocaleString()} tiles`
					+ `${both ? ", plus the overlay's" : ""}.`);
			}
		});
		ui.elDownload.click(download);
		markMode();

		/**
		 * Replaces Potree's bounding-box outline on the 2D map with the real traced
		 * coverage, and puts the Google Earth button where the map is.
		 *
		 * The box is a poor showing next to what File info already computes: the
		 * KML it writes traces the actual footprint, separate blocks as separate
		 * areas and lakes as holes. `gExtent` is an OpenLayers Polygon, and a
		 * Polygon's second and later rings *are* its holes, so the traced rings can
		 * be fed straight into Potree's own styled layer rather than adding another.
		 */
		async function enhanceMapPanel(pointcloud) {
			const fileInfo = window.QCTools && window.QCTools.fileInfo;
			if (!fileInfo || !fileInfo.reportModel || !viewer.mapView) {
				return;
			}

			let model = null;
			try {
				model = await fileInfo.reportModel();
			} catch (e) {
				return;
			}
			if (!model || !model.places || model.places.length === 0) {
				return;
			}

			// Every ring of every area, holes included, as one MultiLineString.
			//
			// Potree's gExtent is a **LineString**, not a Polygon: it only ever held
			// the five corners of a closed box. Feeding it nested rings stores them
			// and draws nothing. Swapping the feature's geometry for a
			// MultiLineString is what lets separate blocks and lakes show at all,
			// and it keeps Potree's own blue styling.
			const rings = [];
			for (const place of model.places) {
				for (const polygon of place.polygons || []) {
					const closed = (ring) => {
						const line = ring.map((point) => ol.proj.fromLonLat(point));
						if (line.length > 1) {
							line.push(line[0]);
						}
						return line;
					};
					rings.push(closed(polygon.outer));
					for (const hole of polygon.holes || []) {
						rings.push(closed(hole));
					}
				}
			}

			if (rings.length > 0 && viewer.mapView.extentsLayer) {
				try {
					const outline = new ol.geom.MultiLineString(rings);
					const features = viewer.mapView.extentsLayer.getSource().getFeatures();
					if (features.length > 0) {
						features[0].setGeometry(outline);
						// gExtent is what MapView.update and view.fit reach for, so it
						// has to agree with what is drawn.
						viewer.mapView.gExtent = outline;
						// Deliberately no view.fit here. The panel is still hidden at
						// this point, so its map has zero size and OpenLayers computes
						// a nonsense resolution from it: the outline ends up a speck in
						// a corner. MapView.load already fitted the view while it had
						// the same problem but the right aspect, and that result is
						// fine, so leave it alone.
					}
				} catch (e) {
					// Keep Potree's box rather than lose the outline entirely.
				}
			}

			if (fileInfo.openInGoogleEarth && $("#qc_map_earth").length === 0) {
				const button = $(`<input id="qc_map_earth" type="button"
					value="Open in Google Earth Pro"
					style="position: absolute; left: 4px; top: 2px; z-index: 1001;"/>`);
				button.click(() => {
					try {
						const result = fileInfo.openInGoogleEarth(model.places);
						button.val(result ? `Opened in ${result.opened}`
							: "Google Earth not found");
					} catch (e) {
						button.val("Could not open Google Earth");
					}
				});
				$("#potree_map_header").append(button);
			}
		}

		/**
		 * Hands Potree the CRS it never got, and remembers where to cache tiles.
		 * MapView.load runs off the `pointcloud_added` event, which has already
		 * fired and bailed by the time we can read the source header, so it has to
		 * be re-run rather than merely primed.
		 */
		function wireProjection(viewer, setStatus) {
			viewer.scene.addEventListener("pointcloud_added", (e) => {
				activate(e.pointcloud, setStatus).catch(() => {});
			});
			for (const pointcloud of viewer.scene.pointclouds) {
				activate(pointcloud, setStatus).catch(() => {});
			}
		}

		async function activate(pointcloud, setStatus) {
			const geometry = pointcloud && pointcloud.pcoGeometry;
			if (!geometry) {
				return;
			}

			if (geometry.url) {
				state.cacheRoot = require("path").dirname(geometry.url);
			}

			// Whatever is already there came from metadata.json and has never been
			// checked, so it goes through the same gate.
			let projection = usableProjection(pointcloud.projection);

			if (!projection) {
				const raw = window.QCFileInfo && window.QCFileInfo.sourceCrs
					? await window.QCFileInfo.sourceCrs(pointcloud) : null;
				projection = usableProjection(raw);

				if (!projection) {
					// Leave pointcloud.projection alone rather than setting something
					// unusable: Potree reaches for it from the render path.
					setStatus(raw
						? "This cloud's coordinate system is one proj4 cannot build a "
							+ "transform for, so it cannot be placed on a map."
						: "No coordinate system in this cloud or its source file, "
							+ "so it cannot be placed on a map.");
					return;
				}
			}

			pointcloud.projection = projection;

			try {
				await viewer.mapView.load(pointcloud);
			} catch (e) {
				// Never let the map take the viewer down with it.
				pointcloud.projection = null;
				console.warn("[QC Tools] map could not place this cloud:", e);
				setStatus("The coordinate system could not be turned into a map transform.");
				return;
			}

			applySource();
			setStatus(viewer.mapView.sceneProjection
				? "Placed on the map. Press Show map."
				: "The coordinate system could not be turned into a map transform.");

			// The traced outline needs the coverage mask, so it lands a moment after
			// the map itself rather than holding it up.
			enhanceMapPanel(pointcloud).catch(() => {});
		}

		return {
			// For the 3D overlay: it reuses the tile maths, the provider choice
			// and the cache rather than keeping a second copy of any of them.
			tileRange: (z) => tileRange(z, state.padding),
			// Imagery colouring wants the footprint itself, with no padding: it is
			// sampling the cloud, not drawing a map around it.
			tileRangeAt: (z, padding) => tileRange(z, padding),
			providerInfo: () => state.provider,
			zoom: () => state.maxZoom,
			isLocal: () => state.local,
			tileUrl: (z, x, y) => tileUrl(z, x, y),
			fetchTile: (z, x, y) => fetchTile(tileUrl(z, x, y)),
			cacheFile: (z, x, y) => {
				if (!state.cacheRoot) {
					return null;
				}
				const file = cachePath(z, x, y);
				return require("fs").existsSync(file) ? file : null;
			},
			tileSrc: (z, x, y) => {
				if (!state.local) {
					return tileUrl(z, x, y);
				}
				if (!state.cacheRoot) {
					return null;
				}
				const file = cachePath(z, x, y);
				return require("fs").existsSync(file)
					? "file:///" + file.replace(/\\/g, "/") : null;
			},
			get provider() { return state.provider.id; },
			get local() { return state.local; },
			setProvider: (id) => ui.elProvider.val(id).trigger("change"),
			setLocal: (on) => (on ? ui.elLocal : ui.elStream).click(),
			download: download,
			plan: () => countTiles(state.padding, state.maxZoom),
			show: () => viewer.toggleMap(),
		};
	}

	window.QCMap = { install: install };
})();
