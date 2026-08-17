/**
 * QC Tools - point cloud file info.
 *
 * One button that reports everything the loaded files record, in a separate
 * window: LAS/COPC public header, every VLR and EVLR with the well-known ones
 * decoded, the COPC info block, the potree metadata and attribute ranges, and
 * two average points/m2 estimates. Plus a button that writes the cloud's extent
 * as KML and opens it in Google Earth, when the file says where it is.
 *
 * The report is built as a document of sections and rows, then rendered twice:
 * as HTML cards for the window, and as plain text for the scripting API and for
 * the in-page fallback. One source, so the two cannot drift.
 *
 * Plain script, loaded before qc_tools.js, which calls QCFileInfo.install().
 * Nothing here touches viewer or loader state - it re-reads the files from disk
 * so that asking for a report can never perturb what is on screen.
 */
(function () {
	"use strict";

	const KEY_WIDTH = 28;          // label column in the plain-text rows
	const TEXT_WIDTH = 76;         // where plain-text prose wraps
	const MASK_MAX_LEVEL = 11;     // footprint raster resolution cap, 2048 x 2048
	const HIERARCHY_MAX_NODES = 2000000;
	const HIERARCHY_BUDGET_MS = 6000;
	const OUTLINE_SEGMENTS = 16;      // points per bounding box edge, in the fallback
	const OUTLINE_MAX_VERTICES = 24000;   // past this a KML is not worth opening

	const COVERAGE_TARGET_LEVEL = 8;      // a 256 x 256 mask where the data allows
	const COVERAGE_SPACING_MARGIN = 3;    // cell at least this many point spacings
	const COVERAGE_MAX_NODES = 1500;
	const COVERAGE_MAX_POINTS = 4000000;

	const EARTH_PRO_PATHS = [
		"C:/Program Files/Google/Google Earth Pro/client/googleearth.exe",
		"C:/Program Files (x86)/Google/Google Earth Pro/client/googleearth.exe",
		"C:/Program Files/Google/Google Earth/client/googleearth.exe",
	];

	// ------------------------------------------------------------------- node io

	/** Slice reader over a local file, the shape copc.js getters expect. */
	function fileGetter(path) {
		const fs = require("fs");
		const fd = fs.openSync(path, "r");
		const size = fs.fstatSync(fd).size;

		const read = async (begin, end) => {
			const stop = Math.min(end, size);
			const length = Math.max(0, stop - begin);
			const buffer = Buffer.allocUnsafe(length);
			if (length > 0) {
				fs.readSync(fd, buffer, 0, length, begin);
			}
			return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
		};

		read.size = size;
		read.close = () => { try { fs.closeSync(fd); } catch (e) { /* already gone */ } };
		return read;
	}

	function statOf(path) {
		try {
			return require("fs").statSync(path);
		} catch (e) {
			return null;
		}
	}

	function siblingPath(url, name) {
		const npath = require("path");
		return npath.join(npath.dirname(url), name);
	}

	// ---------------------------------------------------------------- formatting

	function commas(value) {
		const parts = String(value).split(".");
		parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		return parts.join(".");
	}

	function num(value, digits) {
		if (typeof value !== "number" || !isFinite(value)) {
			return String(value);
		}
		return commas(digits === undefined ? value : value.toFixed(digits));
	}

	/**
	 * A number as written, without thousands separators - integers stay integers.
	 * Coordinates and attribute ranges get pasted into other tools, and 846,175
	 * is not a number anything else will read.
	 */
	function plain(value, digits) {
		if (typeof value !== "number" || !isFinite(value)) {
			return String(value);
		}
		if (Number.isInteger(value)) {
			return String(value);
		}
		return value.toFixed(digits === undefined ? 3 : digits);
	}

	function bytes(count) {
		if (typeof count !== "number" || !isFinite(count)) {
			return "-";
		}
		const units = ["bytes", "KB", "MB", "GB", "TB"];
		let scaled = count;
		let unit = 0;
		while (scaled >= 1024 && unit < units.length - 1) {
			scaled /= 1024;
			unit++;
		}
		if (unit === 0) {
			return `${commas(count)} bytes`;
		}
		return `${scaled.toFixed(1)} ${units[unit]} (${commas(count)} bytes)`;
	}

	function stamp(date) {
		if (!date) {
			return "-";
		}
		const pad = (n) => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
			`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	}

	function shown(value) {
		return (value === undefined || value === null || value === "") ? "-" : String(value);
	}

	function wrap(text, width) {
		const lines = [];
		let line = "";
		for (const word of String(text).split(/\s+/)) {
			if (line === "") {
				line = word;
			} else if (line.length + 1 + word.length <= width) {
				line += " " + word;
			} else {
				lines.push(line);
				line = word;
			}
		}
		if (line !== "") {
			lines.push(line);
		}
		return lines;
	}

	// ------------------------------------------------------------ document model

	/**
	 * Sections of rows, built once and rendered twice. A run of consecutive rows
	 * collapses into one block so the renderers can lay it out as a single table.
	 */
	function document_() {
		const model = { meta: [], notes: [], clouds: [], places: [] };
		let cloud = null;
		let section = null;

		function rows() {
			const last = section.blocks[section.blocks.length - 1];
			if (last && last.kind === "rows") {
				return last.rows;
			}
			const block = { kind: "rows", rows: [] };
			section.blocks.push(block);
			return block.rows;
		}

		const api = {
			model: model,

			meta: (label, value) => {
				model.meta.push({ label: label, value: shown(value) });
				return api;
			},
			note: (text) => {
				model.notes.push(text);
				return api;
			},
			cloud: (name) => {
				cloud = { name: name, sections: [] };
				model.clouds.push(cloud);
				section = null;
				return api;
			},
			/** @param options.wide span every column - for tables and prose. */
			section: (title, options) => {
				if (!cloud) {
					api.cloud(null);
				}
				section = {
					title: title,
					wide: !!(options && options.wide),
					blocks: [],
				};
				cloud.sections.push(section);
				return api;
			},
			kv: (label, value) => {
				rows().push({ label: label, value: shown(value) });
				return api;
			},
			indented: (label, value) => {
				rows().push({ label: label, value: shown(value), indent: true });
				return api;
			},
			/** A value plus the meaning of each of its bits, as indented rows. */
			flags: (label, value, entries) => {
				rows().push({ label: label, value: shown(value) });
				for (const entry of entries) {
					rows().push({ label: entry[0], value: shown(entry[1]), indent: true });
				}
				return api;
			},
			heading: (title) => {
				section.blocks.push({ kind: "heading", title: title });
				return api;
			},
			table: (header, tableRows, align) => {
				section.blocks.push({
					kind: "table", header: header, rows: tableRows, align: align,
				});
				return api;
			},
			pre: (text) => {
				section.blocks.push({ kind: "pre", text: text });
				return api;
			},
			prose: (text) => {
				section.blocks.push({ kind: "prose", text: text });
				return api;
			},
			bar: (label, fraction, value) => {
				section.blocks.push({
					kind: "bar", label: label, fraction: fraction, value: value,
				});
				return api;
			},
			/** Somewhere on the earth this cloud can be drawn. */
			place: (entry) => {
				model.places.push(entry);
				return api;
			},
		};

		return api;
	}

	// --------------------------------------------------------------- text render

	function columnWidths(header, rows) {
		const all = [header].concat(rows);
		return header.map((_, column) =>
			Math.max(...all.map((row) =>
				String(row[column] === undefined ? "" : row[column]).length)));
	}

	function textTable(lines, block) {
		const widths = columnWidths(block.header, block.rows);
		const render = (row) => "  " + row.map((cell, column) => {
			const text = String(cell === undefined ? "" : cell);
			const right = block.align && block.align[column] === "r";
			return right ? text.padStart(widths[column]) : text.padEnd(widths[column]);
		}).join("  ").replace(/\s+$/, "");

		lines.push(render(block.header));
		lines.push("  " + widths.map((w) => "-".repeat(w)).join("  "));
		for (const row of block.rows) {
			lines.push(render(row));
		}
	}

	function textBlock(lines, block) {
		const blank = () => {
			if (lines.length > 0 && lines[lines.length - 1] !== "") {
				lines.push("");
			}
		};

		if (block.kind === "rows") {
			for (const row of block.rows) {
				const label = row.indent
					? "    " + String(row.label).padEnd(KEY_WIDTH - 4)
					: String(row.label).padEnd(KEY_WIDTH);
				lines.push("  " + label + row.value);
			}
		} else if (block.kind === "heading") {
			blank();
			lines.push("  " + block.title);
		} else if (block.kind === "table") {
			blank();
			textTable(lines, block);
		} else if (block.kind === "pre") {
			blank();
			for (const line of String(block.text).split("\n")) {
				lines.push("  " + line);
			}
		} else if (block.kind === "prose") {
			blank();
			for (const line of wrap(block.text, TEXT_WIDTH)) {
				lines.push("  " + line);
			}
		} else if (block.kind === "bar") {
			lines.push("  " + String(block.label).padEnd(KEY_WIDTH) + block.value);
		}
	}

	function toText(model) {
		const lines = ["POINT CLOUD INFO"];

		for (const entry of model.meta) {
			lines.push("  " + String(entry.label).padEnd(KEY_WIDTH) + entry.value);
		}
		for (const note of model.notes) {
			lines.push("");
			for (const line of wrap(note, TEXT_WIDTH)) {
				lines.push("  " + line);
			}
		}

		if (model.clouds.length === 0) {
			lines.push("");
			lines.push("No point cloud is loaded.");
			return lines.join("\n") + "\n";
		}

		for (const cloud of model.clouds) {
			lines.push("");
			lines.push("=".repeat(78));
			lines.push(cloud.name || "Point cloud");
			lines.push("=".repeat(78));

			for (const section of cloud.sections) {
				lines.push("");
				lines.push(section.title.toUpperCase());
				lines.push("-".repeat(section.title.length));
				for (const block of section.blocks) {
					textBlock(lines, block);
				}
			}
		}

		return lines.join("\n") + "\n";
	}

	// --------------------------------------------------------------- html render

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function htmlBlock(block) {
		if (block.kind === "rows") {
			const rows = block.rows.map((row) =>
				`<tr${row.indent ? ' class="sub"' : ""}>` +
				`<th>${escapeHtml(row.label)}</th>` +
				`<td>${escapeHtml(row.value)}</td></tr>`).join("");
			return `<table class="kv">${rows}</table>`;
		}

		if (block.kind === "heading") {
			return `<h3>${escapeHtml(block.title)}</h3>`;
		}

		if (block.kind === "table") {
			const cell = (tag, text, column) => {
				const right = block.align && block.align[column] === "r";
				return `<${tag}${right ? ' class="r"' : ""}>${escapeHtml(text === undefined ? "" : text)}</${tag}>`;
			};
			const head = block.header.map((h, i) => cell("th", h, i)).join("");
			const body = block.rows.map((row) =>
				"<tr>" + block.header.map((_, i) => cell("td", row[i], i)).join("") + "</tr>").join("");
			return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
		}

		if (block.kind === "pre") {
			return `<pre>${escapeHtml(block.text)}</pre>`;
		}

		if (block.kind === "prose") {
			return `<p>${escapeHtml(block.text)}</p>`;
		}

		if (block.kind === "bar") {
			const percent = Math.max(0, Math.min(100, Math.round(100 * block.fraction)));
			return `<div class="meter"><span class="meter-label">${escapeHtml(block.label)}</span>` +
				`<span class="meter-track"><span class="meter-fill" style="width:${percent}%">` +
				`</span><span class="meter-value">${escapeHtml(block.value)}</span></span></div>`;
		}

		return "";
	}

	function htmlSection(section) {
		const body = section.blocks.map(htmlBlock).join("");
		return `<details class="card${section.wide ? " wide" : ""}" open>` +
			`<summary>${escapeHtml(section.title)}</summary>` +
			`<div class="body">${body}</div></details>`;
	}

	/** Roughly how many text rows tall a card will be, for balancing columns. */
	function estimateRows(section) {
		let rows = 2;
		for (const block of section.blocks) {
			if (block.kind === "rows") {
				// A long value wraps, and a file path wraps to three lines - ignoring
				// that is most of the error in a card's estimated height.
				for (const row of block.rows) {
					rows += Math.max(1, Math.ceil(String(row.value).length / 46));
				}
			} else if (block.kind === "table") {
				rows += block.rows.length + 2;
			} else if (block.kind === "pre") {
				rows += Math.min(14, String(block.text).length / 90 + 1);
			} else if (block.kind === "prose") {
				rows += String(block.text).length / 80 + 1;
			} else {
				rows += 1;
			}
		}
		return rows;
	}

	/**
	 * Two columns of cards, packed by height rather than laid out on a grid.
	 *
	 * A CSS grid puts cards in rows, so a two-row card beside a thirty-row card
	 * leaves twenty-eight rows of hole. Multi-column would flow around it but
	 * splits any card taller than the column. So pack them instead: tallest card
	 * first into whichever column is shorter, which balances far better than
	 * taking them in order, then render each column back in document order so
	 * reading a column top to bottom still follows the report. A wide card closes
	 * the pair and spans both.
	 */
	function htmlSections(sections) {
		const parts = [];
		let group = [];

		const flush = () => {
			if (group.length === 0) {
				return;
			}

			const items = group.map((section, index) => ({
				section: section, index: index, height: estimateRows(section),
			}));

			const columns = [[], []];
			const heights = [0, 0];
			for (const item of items.slice().sort((a, b) => b.height - a.height)) {
				const target = heights[0] <= heights[1] ? 0 : 1;
				columns[target].push(item);
				heights[target] += item.height;
			}

			parts.push(`<div class="cols">` + columns.map((column) =>
				`<div class="col">` + column
					.sort((a, b) => a.index - b.index)
					.map((item) => htmlSection(item.section)).join("") +
				`</div>`).join("") + `</div>`);
			group = [];
		};

		for (const section of sections) {
			if (section.wide) {
				flush();
				parts.push(htmlSection(section));
			} else {
				group.push(section);
			}
		}
		flush();

		return parts.join("");
	}

	function earthButtonLabel(count) {
		return count > 1
			? `Show coverage of ${count} clouds in Google Earth`
			: "Show coverage in Google Earth";
	}

	function toHtml(model, title) {
		const meta = model.meta.map((entry) =>
			`<tr><th>${escapeHtml(entry.label)}</th><td>${escapeHtml(entry.value)}</td></tr>`).join("");
		const notes = model.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("");

		const clouds = model.clouds.map((cloud) =>
			`<h2>${escapeHtml(cloud.name || "Point cloud")}</h2>` +
			htmlSections(cloud.sections)).join("");

		const empty = model.clouds.length === 0
			? `<p class="empty">No point cloud is loaded.</p>` : "";

		const placeable = model.places.length > 0;
		const earthLabel = placeable
			? earthButtonLabel(model.places.length)
			: "No coordinate system - cannot place on the earth";

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
	:root { color-scheme: light; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		font: 13px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
		color: #1f2328;
		background: #ffffff;
	}

	/* The bar is the only thing not part of the report, so keep it out of a
	   select-all: user-select none excludes it from the selection entirely. */
	.bar {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 9px 16px;
		background: #f6f7f8;
		border-bottom: 1px solid #d8dbde;
		user-select: none;
		-webkit-user-select: none;
	}
	.bar h1 { margin: 0; font-size: 14px; font-weight: 600; }
	.bar .spacer { flex-grow: 1; }
	.bar .hint { color: #6a737c; font-size: 12px; }
	button {
		font: inherit;
		padding: 5px 12px;
		border: 1px solid #c3c8cd;
		border-radius: 4px;
		background: #ffffff;
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover:not(:disabled) { background: #eaeef2; }
	button:disabled { color: #9aa1a8; border-color: #dfe2e5; cursor: default; }

	main { padding: 8px 16px 44px 16px; }
	h2 {
		font-size: 14px;
		font-weight: 600;
		margin: 20px 0 10px 0;
		padding-bottom: 6px;
		border-bottom: 2px solid #1f2328;
	}
	h3 {
		margin: 14px 0 2px 0;
		font-size: 12px;
		font-weight: 600;
		color: #4d565e;
	}
	p { margin: 8px 0; color: #39424a; max-width: 74ch; }
	p.empty { padding: 12px 0; }

	.meta { margin: 10px 0 4px 0; max-width: 440px; }
	.cols {
		display: grid;
		gap: 14px 20px;
		grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
		align-items: start;
		margin-bottom: 14px;
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}
	.card {
		border: 1px solid #e2e5e8;
		border-radius: 5px;
		background: #ffffff;
		overflow: hidden;
	}
	.card.wide { margin-bottom: 14px; }
	.card > summary {
		cursor: pointer;
		padding: 7px 12px;
		font-size: 12px;
		letter-spacing: 0.03em;
		color: #4d565e;
		background: #fafbfc;
	}
	.card[open] > summary { border-bottom: 1px solid #e2e5e8; }
	.card > .body { padding: 4px 12px 10px 12px; overflow-x: auto; }

	table { width: 100%; border-collapse: collapse; }
	.kv th {
		font-weight: 400;
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
		padding: 5px 10px 5px 0;
		font-size: 11px;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #b3641c;
	}
	.kv td {
		text-align: right;
		vertical-align: top;
		padding: 5px 0;
		word-break: break-word;
		font-variant-numeric: tabular-nums;
	}
	.kv tr + tr th, .kv tr + tr td { border-top: 1px solid #eef0f2; }
	/* On a full-width card the value column would otherwise sit a screen away
	   from its label. Tables of their own keep the full width. */
	.card.wide .kv { max-width: 820px; }
	.kv tr.sub th {
		text-align: right;
		padding-left: 24px;
		text-transform: none;
		letter-spacing: 0;
		color: #7d868e;
	}
	.data th {
		text-align: left;
		font-weight: 400;
		font-size: 11px;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #b3641c;
		padding: 5px 12px 5px 0;
		border-bottom: 1px solid #d8dbde;
		white-space: nowrap;
	}
	.data td {
		padding: 4px 12px 4px 0;
		vertical-align: top;
		font-variant-numeric: tabular-nums;
	}
	.data tbody tr + tr td { border-top: 1px solid #f2f4f5; }
	.data th.r, .data td.r { text-align: right; }

	pre {
		margin: 8px 0;
		padding: 8px 10px;
		font: 12px/1.5 Consolas, "DejaVu Sans Mono", "Courier New", monospace;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		background: #f6f7f8;
		border: 1px solid #e6e9eb;
		border-radius: 4px;
	}

	.meter { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
	.meter-label {
		font-size: 11px;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #b3641c;
		white-space: nowrap;
	}
	.meter-track {
		position: relative;
		flex-grow: 1;
		height: 18px;
		background: #e7eaed;
		border-radius: 3px;
		overflow: hidden;
	}
	.meter-fill { position: absolute; inset: 0 auto 0 0; background: #23456b; }
	.meter-value {
		position: relative;
		display: block;
		padding: 0 8px;
		line-height: 18px;
		font-size: 11px;
		color: #ffffff;
		mix-blend-mode: difference;
	}

	::selection { background: #bcd4f0; }

	@media print {
		.bar { display: none; }
		.card { break-inside: avoid; }
	}
</style>
</head>
<body>
<div class="bar">
	<h1>${escapeHtml(title)}</h1>
	<span class="hint">Ctrl+A then Ctrl+C copies the whole report</span>
	<span class="spacer"></span>
	<button id="qc_earth"${placeable ? "" : " disabled"}>${escapeHtml(earthLabel)}</button>
</div>
<main>
<table class="kv meta">${meta}</table>
${notes}
${empty}
${clouds}
</main>
</body>
</html>`;
	}

	// -------------------------------------------------------------- las lookups

	const POINT_FORMATS = {
		0: "legacy core",
		1: "legacy core + GPS time",
		2: "legacy core + RGB",
		3: "legacy core + GPS time + RGB",
		4: "legacy core + GPS time + wave packets",
		5: "legacy core + GPS time + RGB + wave packets",
		6: "extended core + GPS time",
		7: "extended core + GPS time + RGB",
		8: "extended core + GPS time + RGB + NIR",
		9: "extended core + GPS time + wave packets",
		10: "extended core + GPS time + RGB + NIR + wave packets",
	};

	// Bit 0 set means adjusted standard GPS time, so the flag reads the other way
	// round - which is how the COPC validator labels it too.
	const ENCODING_BITS = [
		["GPS week time", true],
		["waveform packets internal", false],
		["waveform packets external", false],
		["synthetic return numbers", false],
		["WKT", false],
	];

	// ASPRS classes for the LAS 1.4 point formats. Formats 0-5 differ at 8 and
	// 12, which the report notes rather than silently mislabelling.
	const CLASSES = {
		0: "created, never classified",
		1: "unclassified",
		2: "ground",
		3: "low vegetation",
		4: "medium vegetation",
		5: "high vegetation",
		6: "building",
		7: "low point (noise)",
		8: "reserved (model key-point in LAS 1.1-1.3)",
		9: "water",
		10: "rail",
		11: "road surface",
		12: "reserved (overlap in LAS 1.1-1.3)",
		13: "wire - guard (shield)",
		14: "wire - conductor (phase)",
		15: "transmission tower",
		16: "wire-structure connector",
		17: "bridge deck",
		18: "high noise",
		19: "overhead structure",
		20: "ignored ground",
		21: "snow",
		22: "temporal exclusion",
	};

	const GEO_KEYS = {
		1024: "GTModelType",
		1025: "GTRasterType",
		2048: "GeographicType",
		2049: "GeogCitation",
		2050: "GeogGeodeticDatum",
		2054: "GeogAngularUnits",
		2056: "GeogEllipsoid",
		3072: "ProjectedCSType",
		3073: "PCSCitation",
		3074: "Projection",
		3075: "ProjCoordTrans",
		3076: "ProjLinearUnits",
		4096: "VerticalCSType",
		4098: "VerticalCitation",
		4099: "VerticalUnits",
	};

	function classLabel(code) {
		return CLASSES[code] || (code <= 63 ? "reserved" : "user definable");
	}

	// --------------------------------------------------------------------- wkt

	/** The bracket-balanced text of the first `KEYWORD[...]` node in a WKT string. */
	function wktNode(wkt, keyword) {
		const start = wkt.indexOf(keyword + "[");
		if (start < 0) {
			return null;
		}
		let depth = 0;
		for (let i = start + keyword.length; i < wkt.length; i++) {
			if (wkt[i] === "[") {
				depth++;
			} else if (wkt[i] === "]") {
				depth--;
				if (depth === 0) {
					return wkt.slice(start, i + 1);
				}
			}
		}
		return null;
	}

	/** The horizontal node of a WKT string, projected for preference. */
	function horizontalNode(wkt) {
		const text = String(wkt);
		const projected = wktNode(text, "PROJCS") || wktNode(text, "PROJCRS");
		if (projected) {
			return { node: projected, projected: true };
		}
		const geographic = wktNode(text, "GEOGCS") || wktNode(text, "GEOGCRS");
		return geographic ? { node: geographic, projected: false } : null;
	}

	/**
	 * The EPSG code and name of the horizontal system a WKT string describes.
	 *
	 * Taking the last AUTHORITY in the whole string does not work: on a compound
	 * system the last one belongs to the vertical unit, so a UTM zone reads back
	 * as EPSG:9001, metre. The code wanted is the one closing the PROJCS (or the
	 * GEOGCS on a geographic file), which is that node's own final element.
	 */
	function crsFromWkt(wkt) {
		const horizontal = horizontalNode(wkt);
		if (!horizontal) {
			return null;
		}

		const name = /^[A-Z]+\s*\[\s*"([^"]*)"/.exec(horizontal.node);
		const codes = horizontal.node.match(
			/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi);
		const last = codes ? /(\d+)/.exec(codes[codes.length - 1]) : null;

		if (!last && !name) {
			return null;
		}
		return {
			epsg: last ? parseInt(last[1], 10) : null,
			name: name ? name[1] : null,
			projected: horizontal.projected,
			label: (last ? `EPSG:${last[1]}` : "no EPSG code") +
				(name ? `  (${name[1]})` : ""),
		};
	}

	// -------------------------------------------------------------------- earth

	/**
	 * A proj4 definition that will take this cloud's coordinates to lon/lat.
	 *
	 * proj4 parses a WKT1 `PROJCS[...]` node but not the `COMPD_CS[...]` that
	 * wraps it on a file with a vertical system, and it knows almost no EPSG
	 * codes by name - `proj4("EPSG:32610")` throws. So: hand it the extracted
	 * node, and fall back to building a UTM definition from the code, which
	 * covers most of what surveys actually ship.
	 */
	function projectionFor(wkt, epsg, potreeProjection) {
		const proj4 = window.proj4;
		if (!proj4) {
			return null;
		}

		const candidates = [];

		if (wkt) {
			const horizontal = horizontalNode(wkt);
			if (horizontal) {
				candidates.push({ def: horizontal.node, from: "the WKT in the file" });
			}
		}
		if (typeof epsg === "number") {
			if (epsg >= 32601 && epsg <= 32660) {
				candidates.push({
					def: `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`,
					from: `EPSG:${epsg}, UTM zone ${epsg - 32600}N`,
				});
			} else if (epsg >= 32701 && epsg <= 32760) {
				candidates.push({
					def: `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`,
					from: `EPSG:${epsg}, UTM zone ${epsg - 32700}S`,
				});
			} else if (epsg === 4326) {
				candidates.push({
					def: "+proj=longlat +datum=WGS84 +no_defs",
					from: "EPSG:4326",
				});
			}
		}
		if (potreeProjection) {
			candidates.push({ def: potreeProjection, from: "the potree metadata" });
		}

		for (const candidate of candidates) {
			try {
				const transform = proj4(candidate.def, "EPSG:4326");
				if (transform) {
					return { transform: transform, from: candidate.from };
				}
			} catch (e) {
				// Try the next one.
			}
		}
		return null;
	}

	/**
	 * The bounding box outline in lon/lat. Walking each edge rather than taking
	 * the four corners keeps the shape honest: a projected rectangle is not a
	 * rectangle in lon/lat, and over a kilometre or two the difference shows.
	 */
	function outlineOf(tight, projection) {
		const points = [];
		const add = (x, y) => {
			try {
				const result = projection.transform.forward([x, y]);
				const lon = result[0];
				const lat = result[1];
				if (isFinite(lon) && isFinite(lat) &&
						Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
					points.push([lon, lat]);
					return true;
				}
			} catch (e) {
				// Outside the projection's domain.
			}
			return false;
		};

		const lerp = (a, b, t) => a + (b - a) * t;
		const n = OUTLINE_SEGMENTS;
		let ok = true;
		for (let i = 0; i < n && ok; i++) { ok = add(lerp(tight.minX, tight.maxX, i / n), tight.minY); }
		for (let i = 0; i < n && ok; i++) { ok = add(tight.maxX, lerp(tight.minY, tight.maxY, i / n)); }
		for (let i = 0; i < n && ok; i++) { ok = add(lerp(tight.maxX, tight.minX, i / n), tight.maxY); }
		for (let i = 0; i < n && ok; i++) { ok = add(tight.minX, lerp(tight.maxY, tight.minY, i / n)); }

		if (!ok || points.length < 4) {
			return null;
		}
		points.push(points[0]);
		return points;
	}

	function escapeXml(text) {
		return String(text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	/**
	 * The coverage as a KML document, one placemark per cloud.
	 *
	 * Each traced area becomes a Polygon, its holes become innerBoundaryIs rings,
	 * and several areas from one cloud go in a MultiGeometry so they stay a single
	 * placemark you can switch on and off as one thing.
	 */
	function toKml(places) {
		const ring = (points, indent) => {
			const pad = "\t".repeat(indent + 1);
			const coordinates = points
				.map((point) => `${point[0].toFixed(9)},${point[1].toFixed(9)},0`)
				.join("\n" + pad + "\t");
			return `${"\t".repeat(indent)}<LinearRing>\n` +
				`${pad}<coordinates>\n${pad}\t${coordinates}\n${pad}</coordinates>\n` +
				`${"\t".repeat(indent)}</LinearRing>`;
		};

		const polygon = (shape, indent) => {
			const pad = "\t".repeat(indent);
			const inner = shape.holes.map((hole) =>
				`${pad}\t<innerBoundaryIs>\n${ring(hole, indent + 2)}\n${pad}\t</innerBoundaryIs>`)
				.join("\n");
			return `${pad}<Polygon>\n` +
				`${pad}\t<tessellate>1</tessellate>\n` +
				`${pad}\t<outerBoundaryIs>\n${ring(shape.outer, indent + 2)}\n${pad}\t</outerBoundaryIs>` +
				(inner ? "\n" + inner : "") + `\n${pad}</Polygon>`;
		};

		const placemarks = places.map((place) => {
			const rows = [
				["Points", commas(place.points)],
				["Bounding box", `${num(place.extent.dx, 1)} x ${num(place.extent.dy, 1)} m`],
				["Outline", place.traced
					? `traced coverage, ${num(place.cell, 2)} m cells`
					: "bounding box only"],
				["Areas", String(place.polygons.length)],
				["Holes", String(place.holes)],
				["Coordinate system", place.crs || "-"],
				["Centre", `${place.centre[1].toFixed(6)}, ${place.centre[0].toFixed(6)}`],
				["Transform", place.source || "-"],
			].map((row) =>
				`<tr><td><b>${escapeXml(row[0])}</b></td><td>${escapeXml(row[1])}</td></tr>`)
				.join("");

			const geometry = place.polygons.length === 1
				? polygon(place.polygons[0], 2)
				: `\t\t<MultiGeometry>\n` +
					place.polygons.map((shape) => polygon(shape, 3)).join("\n") +
					`\n\t\t</MultiGeometry>`;

			return `	<Placemark>
		<name>${escapeXml(place.name)}</name>
		<description><![CDATA[<table>${rows}</table>]]></description>
		<styleUrl>#qc-extent</styleUrl>
${geometry}
	</Placemark>`;
		}).join("\n");

		return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
	<name>Point cloud coverage</name>
	<description>Written by PotreeDesktop QC Tools.</description>
	<Style id="qc-extent">
		<LineStyle><color>ff1478ff</color><width>3</width></LineStyle>
		<PolyStyle><color>3c1478ff</color></PolyStyle>
	</Style>
${placemarks}
</Document>
</kml>
`;
	}

	/**
	 * Write the extents to a KML and hand it to Google Earth. Prefers the Pro
	 * client by path, because that is what a survey desktop has and it opens the
	 * file as a temporary place rather than asking anything.
	 */
	function openInGoogleEarth(places) {
		const fs = require("fs");
		const os = require("os");
		const npath = require("path");

		const stem = (places.length === 1 ? places[0].name : "point_clouds")
			.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "point_cloud";
		const file = npath.join(os.tmpdir(), `qc_extent_${stem}.kml`);

		fs.writeFileSync(file, toKml(places), "utf8");

		const exe = EARTH_PRO_PATHS.find((candidate) => {
			try {
				return fs.existsSync(candidate);
			} catch (e) {
				return false;
			}
		});

		if (exe) {
			require("child_process")
				.spawn(exe, [file], { detached: true, stdio: "ignore" })
				.unref();
			return { file: file, opened: "Google Earth Pro" };
		}

		// No Pro install found - let whatever owns .kml have it.
		require("electron").shell.openPath(file);
		return { file: file, opened: "the default .kml application" };
	}

	// ---------------------------------------------------------------- las report

	/**
	 * Reads a LAS/LAZ/COPC file from disk and writes the full public header, the
	 * VLR/EVLR list, the decoded well-known records and, for a COPC file, the
	 * info block. Returns what the caller needs for the density and earth work.
	 */
	async function lasSection(out, path, label) {
		const { Las, Copc } = window.Copc;

		const stat = statOf(path);
		out.section(label);
		out.kv("File", path);
		out.kv("Size on disk", stat ? bytes(stat.size) : "not found");
		out.kv("Modified", stat ? stamp(stat.mtime) : "-");

		if (!stat) {
			out.prose("The file is not where it was when the cloud was loaded or converted.");
			return null;
		}

		let getter = null;
		try {
			// Inside the try as well: the file exists, but it can still be locked.
			getter = fileGetter(path);

			let header = null;
			let vlrs = [];
			let copc = null;

			try {
				copc = await Copc.create(getter);
				header = copc.header;
				vlrs = copc.vlrs;
			} catch (e) {
				// Not a COPC file, or not readable as one - fall back to plain LAS.
				header = Las.Header.parse(await getter(0, Las.Constants.minHeaderLength));
				vlrs = await Las.Vlr.walk(getter, header);
			}

			writeHeader(out, header, copc);

			const compressed = !!Las.Vlr.find(vlrs, "laszip encoded", 22204);
			if (compressed) {
				writeCompression(out, header, stat.size);
			}

			writeVlrs(out, vlrs);
			const known = await writeKnownVlrs(out, getter, vlrs);

			if (copc) {
				writeCopcInfo(out, copc);
				writeExtraBytes(out, copc.eb);
			}

			return {
				header: header, vlrs: vlrs, copc: copc, getter: getter,
				wkt: known.wkt, geotiff: known.geotiff,
			};
		} catch (e) {
			out.kv("Could not be read", e && e.message ? e.message : String(e));
			out.prose("copc.js reads LAS 1.2 and 1.4 only; an older revision reports this way.");
			if (getter) {
				getter.close();
			}
			return null;
		}
	}

	function writeHeader(out, header, copc) {
		out.kv("Format", copc
			? `COPC (LAS ${header.majorVersion}.${header.minorVersion}, LAZ compressed)`
			: `LAS ${header.majorVersion}.${header.minorVersion}`);
		out.kv("File signature", header.fileSignature);
		out.kv("File source id", header.fileSourceId);

		out.flags("Global encoding", header.globalEncoding,
			ENCODING_BITS.map((entry, bit) => {
				const set = ((header.globalEncoding >> bit) & 1) === 1;
				return [entry[0], (entry[1] ? !set : set) ? "True" : "False"];
			}).concat([["bits 5-15", header.globalEncoding >> 5]]));

		out.kv("Project id / GUID", header.projectId);
		out.kv("Major version", header.majorVersion);
		out.kv("Minor version", header.minorVersion);
		out.kv("System identifier", header.systemIdentifier || "(empty)");
		out.kv("Generating software", header.generatingSoftware || "(empty)");
		out.kv("File creation day-of-year", header.fileCreationDayOfYear);
		out.kv("File creation year", header.fileCreationYear ||
			`${header.fileCreationYear} (not set)`);
		out.kv("Header length", `${header.headerLength} bytes`);

		// Split out rather than run on: the header is otherwise one card taller
		// than everything beside it, which no column packing can balance.
		out.section("point records");
		out.kv("Point data offset", `${commas(header.pointDataOffset)} bytes`);
		out.kv("Point data record format", `${header.pointDataRecordFormat}` +
			(POINT_FORMATS[header.pointDataRecordFormat]
				? `  (${POINT_FORMATS[header.pointDataRecordFormat]})` : ""));
		out.kv("Point data record length", `${header.pointDataRecordLength} bytes`);
		out.kv("Point count", commas(header.pointCount));

		const byReturn = (header.pointCountByReturn || [])
			.map((count, index) => [index + 1, count])
			.filter((entry) => entry[1] > 0);
		out.flags("Point count by return",
			byReturn.length ? `${byReturn.length} returns in use` : "(none recorded)",
			byReturn.map((entry) => [String(entry[0]), commas(entry[1])]));

		out.kv("VLR count", header.vlrCount);
		out.kv("EVLR count", header.evlrCount);
		out.kv("EVLR offset", commas(header.evlrOffset));
		out.kv("Waveform data offset", commas(header.waveformDataOffset));

		const size = [
			header.max[0] - header.min[0],
			header.max[1] - header.min[1],
			header.max[2] - header.min[2],
		];
		out.section("las extent");
		out.table(["", "x", "y", "z"], [
			["scale"].concat(Array.from(header.scale).map((v) => plain(v, 6))),
			["offset"].concat(Array.from(header.offset).map((v) => plain(v, 3))),
			["min"].concat(Array.from(header.min).map((v) => plain(v, 3))),
			["max"].concat(Array.from(header.max).map((v) => plain(v, 3))),
			["extent"].concat(size.map((v) => plain(v, 3))),
		], ["l", "r", "r", "r"]);
	}

	/**
	 * What LASzip bought. The uncompressed figure is the header and records the
	 * file would need laid out flat, which is what the ratio is against.
	 */
	function writeCompression(out, header, fileSize) {
		const uncompressed = header.pointDataOffset +
			header.pointCount * header.pointDataRecordLength;

		out.section("compression");
		out.kv("Point count", commas(header.pointCount));
		out.kv("Compression ratio", (uncompressed / fileSize).toFixed(3));
		out.kv("File size", `${commas(fileSize)} bytes`);
		out.kv("Uncompressed size", `${commas(uncompressed)} bytes`);

		const savings = 1 - fileSize / uncompressed;
		out.bar("Data savings", savings, `${Math.round(100 * savings)}%`);
	}

	function writeVlrs(out, vlrs) {
		out.section("vlrs", { wide: vlrs.length > 4 });

		if (vlrs.length === 0) {
			out.kv("Variable length records", "(none)");
			return;
		}

		out.table(["#", "kind", "user id", "record", "length", "description"],
			vlrs.map((vlr, index) => [
				String(index + 1),
				vlr.isExtended ? "EVLR" : "VLR",
				vlr.userId,
				String(vlr.recordId),
				commas(vlr.contentLength),
				vlr.description || "",
			]), ["r", "l", "l", "r", "r", "l"]);
	}

	/** The records that carry information rather than payload, decoded. */
	async function writeKnownVlrs(out, getter, vlrs) {
		const { Las, Binary } = window.Copc;
		const find = (userId, recordId) => Las.Vlr.find(vlrs, userId, recordId);

		let wkt = null;
		let geotiff = null;

		const wktVlr = find("LASF_Projection", 2112);
		if (wktVlr && wktVlr.contentLength) {
			wkt = Binary.toCString(await Las.Vlr.fetch(getter, wktVlr));
			out.section("wkt", { wide: true });
			out.kv("Record", "LASF_Projection 2112, OGC coordinate system WKT");
			const crs = crsFromWkt(wkt);
			if (crs) {
				out.kv("Authority", crs.label);
				out.kv("Kind", crs.projected ? "projected" : "geographic");
			}
			out.pre(wkt);
		}

		const geoKeyVlr = find("LASF_Projection", 34735);
		if (geoKeyVlr && geoKeyVlr.contentLength) {
			geotiff = await writeGeoKeys(out, getter, vlrs, geoKeyVlr);
		}

		if (!wktVlr && !geoKeyVlr) {
			out.section("coordinate system");
			out.kv("Coordinate system", "(none)");
			out.prose("The file carries no LASF_Projection record, so it does not say " +
				"where on the earth it is.");
		}

		const ebVlr = find("LASF_Spec", 4);
		if (ebVlr && ebVlr.contentLength) {
			try {
				writeExtraBytes(out, Las.ExtraBytes.parse(await Las.Vlr.fetch(getter, ebVlr)));
			} catch (e) {
				out.section("extra bytes");
				out.kv("LASF_Spec 4", `could not be parsed: ${e.message}`);
			}
		}

		const textVlr = find("LASF_Spec", 3);
		if (textVlr && textVlr.contentLength) {
			out.section("text area description", { wide: true });
			out.pre(Binary.toCString(await Las.Vlr.fetch(getter, textVlr)));
		}

		return { wkt: wkt, geotiff: geotiff };
	}

	/**
	 * The GeoTIFF key form of a coordinate system, which is how LAS 1.2 files and
	 * anything not setting the WKT global-encoding bit declare theirs. Returns the
	 * same shape as crsFromWkt so the rest of the report does not care which.
	 */
	async function writeGeoKeys(out, getter, vlrs, geoKeyVlr) {
		const { Las, Binary } = window.Copc;

		out.section("geotiff keys", { wide: true });
		out.kv("Record", "LASF_Projection 34735, GeoTIFF keys");

		let projectedEpsg = null;
		let geographicEpsg = null;
		let projectedName = null;
		let geographicName = null;

		try {
			const raw = await Las.Vlr.fetch(getter, geoKeyVlr);
			const view = Binary.toDataView(raw);
			const count = view.getUint16(6, true);

			let ascii = "";
			const asciiVlr = Las.Vlr.find(vlrs, "LASF_Projection", 34737);
			if (asciiVlr && asciiVlr.contentLength) {
				const asciiRaw = await Las.Vlr.fetch(getter, asciiVlr);
				ascii = String.fromCharCode.apply(null, Array.from(asciiRaw));
			}

			let doubles = null;
			const doubleVlr = Las.Vlr.find(vlrs, "LASF_Projection", 34736);
			if (doubleVlr && doubleVlr.contentLength) {
				const doubleRaw = await Las.Vlr.fetch(getter, doubleVlr);
				doubles = new Float64Array(doubleRaw.buffer.slice(
					doubleRaw.byteOffset, doubleRaw.byteOffset + doubleRaw.byteLength));
			}

			const rows = [];
			for (let i = 0; i < count; i++) {
				const base = 8 + i * 8;
				if (base + 8 > view.byteLength) {
					break;
				}
				const keyId = view.getUint16(base, true);
				const location = view.getUint16(base + 2, true);
				const valueCount = view.getUint16(base + 4, true);
				const offset = view.getUint16(base + 6, true);

				let value;
				if (location === 0) {
					value = String(offset);
				} else if (location === 34737) {
					value = ascii.substr(offset, valueCount).replace(/\|$/, "");
				} else if (location === 34736 && doubles) {
					value = Array.from(doubles.slice(offset, offset + valueCount)).join(", ");
				} else {
					value = `(tag ${location}, ${valueCount} values at ${offset})`;
				}

				rows.push([String(keyId), GEO_KEYS[keyId] || "", value]);

				const code = (location === 0 && offset > 0 && offset < 32767) ? offset : null;
				if (keyId === 3072 && code) {
					projectedEpsg = code;
					out.kv("Horizontal system", `EPSG:${code}`);
				}
				if (keyId === 2048 && code) {
					geographicEpsg = code;
				}
				if (keyId === 3073) {
					projectedName = value;
				}
				if (keyId === 2049) {
					geographicName = value;
				}
				if (keyId === 4096 && code) {
					out.kv("Vertical system", `EPSG:${code}`);
				}
			}

			out.table(["key", "name", "value"], rows, ["r", "l", "l"]);
		} catch (e) {
			out.kv("Could not be parsed", e.message);
		}

		if (projectedEpsg) {
			return {
				epsg: projectedEpsg, name: projectedName, projected: true,
				label: `EPSG:${projectedEpsg}` + (projectedName ? `  (${projectedName})` : ""),
			};
		}
		if (geographicEpsg) {
			return {
				epsg: geographicEpsg, name: geographicName, projected: false,
				label: `EPSG:${geographicEpsg}` + (geographicName ? `  (${geographicName})` : ""),
			};
		}
		return null;
	}

	function writeCopcInfo(out, copc) {
		const info = copc.info;
		out.section("copc info");
		out.kv("Record", "copc 1");
		out.kv("Cube min", Array.from(info.cube.slice(0, 3)).map((v) => plain(v, 3)).join("   "));
		out.kv("Cube max", Array.from(info.cube.slice(3, 6)).map((v) => plain(v, 3)).join("   "));
		out.kv("Cube side", `${num(info.cube[3] - info.cube[0], 3)} m`);
		out.kv("Root spacing", `${num(info.spacing, 4)} m`);
		out.kv("Root hierarchy offset", commas(info.rootHierarchyPage.pageOffset));
		out.kv("Root hierarchy length", `${commas(info.rootHierarchyPage.pageLength)} bytes`);
		out.kv("GPS time range", info.gpsTimeRange
			? `${num(info.gpsTimeRange[0], 6)} .. ${num(info.gpsTimeRange[1], 6)}` : "-");
	}

	function writeExtraBytes(out, descriptors) {
		if (!descriptors || descriptors.length === 0) {
			return;
		}
		out.section("extra bytes", { wide: true });
		out.kv("Dimensions", descriptors.length);
		for (const descriptor of descriptors) {
			out.pre(JSON.stringify(descriptor));
		}
	}

	// ------------------------------------------------------------ potree report

	function writePotreeSection(out, metadata, url) {
		out.section("potree octree");
		out.kv("File", url || "-");
		out.kv("Metadata version", metadata.version);
		out.kv("Name", metadata.name);
		out.kv("Description", metadata.description || "(empty)");
		out.kv("Points", commas(metadata.points));
		out.kv("Encoding", metadata.encoding);
		out.kv("Root spacing", `${num(metadata.spacing, 6)} m`);
		if (metadata.hierarchy) {
			out.kv("Hierarchy depth", metadata.hierarchy.depth);
			out.kv("Hierarchy step size", metadata.hierarchy.stepSize);
			out.kv("First chunk", `${commas(metadata.hierarchy.firstChunkSize)} bytes`);
		}
		out.kv("Projection", metadata.projection ||
			"(empty - PotreeConverter did not carry the CRS across)");

		if (url) {
			out.section("files on disk");
			for (const name of ["metadata.json", "hierarchy.bin", "octree.bin"]) {
				const stat = statOf(siblingPath(url, name));
				out.kv(name, stat ? bytes(stat.size) : "(missing)");
			}
		}

		const position = (metadata.attributes || []).find((a) => a.name === "position");
		const rows = [];

		if (metadata.boundingBox) {
			const min = metadata.boundingBox.min;
			const max = metadata.boundingBox.max;
			rows.push(["cube min"].concat(Array.from(min).map((v) => plain(v, 3))));
			rows.push(["cube max"].concat(Array.from(max).map((v) => plain(v, 3))));
			rows.push(["cube side"].concat(
				[max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => plain(v, 3))));
		}
		if (position) {
			rows.push(["tight min"].concat(Array.from(position.min).map((v) => plain(v, 3))));
			rows.push(["tight max"].concat(Array.from(position.max).map((v) => plain(v, 3))));
			rows.push(["tight extent"].concat([
				position.max[0] - position.min[0],
				position.max[1] - position.min[1],
				position.max[2] - position.min[2],
			].map((v) => plain(v, 3))));
		}

		if (rows.length > 0) {
			out.section("octree extent");
			out.table(["", "x", "y", "z"], rows, ["l", "r", "r", "r"]);
			out.prose("PotreeConverter 2 stores a cubic bounding box, so on a flat cloud " +
				"its z range is mostly empty air. The tight extent is what the points " +
				"actually span.");
		}

		writeAttributes(out, metadata.attributes || []);
		writeClassHistogram(out, metadata.attributes || []);
	}

	function writeAttributes(out, attributes) {
		if (attributes.length === 0) {
			return;
		}
		out.section("attributes stored in the octree", { wide: true });
		out.table(["name", "type", "bytes", "elems", "min", "max"],
			attributes.map((attribute) => [
				attribute.name,
				attribute.type,
				String(attribute.size),
				String(attribute.numElements),
				(attribute.min || []).map((v) => plain(v, 3)).join("  "),
				(attribute.max || []).map((v) => plain(v, 3)).join("  "),
			]), ["l", "l", "r", "r", "l", "l"]);
	}

	function writeClassHistogram(out, attributes) {
		const classification = attributes.find((a) => a.name === "classification");
		if (!classification || !classification.histogram) {
			return;
		}

		let total = 0;
		classification.histogram.forEach((count) => {
			if (count > 0) {
				total += count;
			}
		});

		const rows = [];
		classification.histogram.forEach((count, code) => {
			if (count > 0) {
				rows.push([
					String(code),
					classLabel(code),
					commas(count),
					`${(100 * count / total).toFixed(2)} %`,
				]);
			}
		});

		out.section("classes present", { wide: rows.length > 6 });
		if (rows.length === 0) {
			out.kv("Classes", "(the histogram is empty)");
			return;
		}
		out.table(["code", "class", "points", "share"], rows, ["r", "l", "r", "r"]);
	}

	// ---------------------------------------------------------------- footprint

	/** The plan-view rectangle the points actually span. */
	function tightRect(min, max) {
		return {
			minX: min[0], minY: min[1], maxX: max[0], maxY: max[1],
			dx: max[0] - min[0], dy: max[1] - min[1],
		};
	}

	/** Origin and side of the cubic root node a COPC file declares. */
	function copcCube(copc) {
		return {
			minX: copc.info.cube[0],
			minY: copc.info.cube[1],
			side: copc.info.cube[3] - copc.info.cube[0],
		};
	}

	/**
	 * Average points per square metre needs an area, and the honest area is the
	 * part of the plan view that actually holds points - not the whole bounding
	 * rectangle, which a corridor or an L-shaped block barely fills.
	 *
	 * The octree already knows this: a node exists only where there is data, so
	 * projecting the deepest nodes onto an xy raster gives the occupied footprint
	 * without reading a single point. Node point *counts* would be wrong here -
	 * the tree is additive, so they undercount - but mere existence is exact.
	 */
	function rasterize(frontier, cube, tight) {
		if (frontier.length === 0) {
			return null;
		}

		let deepest = 0;
		for (const node of frontier) {
			deepest = Math.max(deepest, node.level);
		}

		const level = Math.min(deepest, MASK_MAX_LEVEL);
		const width = 1 << level;
		const mask = new Uint8Array(width * width);

		for (const node of frontier) {
			if (node.level >= level) {
				const shift = node.level - level;
				mask[(node.iy >>> shift) * width + (node.ix >>> shift)] = 1;
				continue;
			}

			// A node that has no children still covers its whole cube, so it marks
			// the block of cells under it. That overstates a sparse fringe badly, and
			// it is why this is only the fallback - see coverageFromPoints.
			const shift = level - node.level;
			const span = 1 << shift;
			const x0 = node.ix << shift;
			const y0 = node.iy << shift;
			for (let y = y0; y < y0 + span; y++) {
				const row = y * width;
				for (let x = x0; x < x0 + span; x++) {
					mask[row + x] = 1;
				}
			}
		}

		return measureMask(mask, width, level, cube, tight, "octree node cubes");
	}

	/**
	 * The area a mask covers, and the mask packaged for everything downstream.
	 *
	 * A cell on the perimeter is only partly inside the cloud, so its area is
	 * clipped to the tight extent. Without that the marked area can come out
	 * larger than the bounding box itself, by roughly perimeter x cell.
	 */
	function measureMask(mask, width, level, cube, tight, source) {
		const cell = cube.side / width;
		let cells = 0;
		let area = 0;

		for (let y = 0; y < width; y++) {
			const y0 = cube.minY + y * cell;
			const overlapY = tight
				? Math.min(y0 + cell, tight.maxY) - Math.max(y0, tight.minY)
				: cell;
			const row = y * width;
			for (let x = 0; x < width; x++) {
				if (mask[row + x] === 0) {
					continue;
				}
				cells++;
				if (overlapY <= 0) {
					continue;
				}
				const x0 = cube.minX + x * cell;
				const overlapX = tight
					? Math.min(x0 + cell, tight.maxX) - Math.max(x0, tight.minX)
					: cell;
				if (overlapX > 0) {
					area += overlapX * overlapY;
				}
			}
		}

		// The mask is the cloud's plan-view shape, so it is worth more than the
		// area it was built for: the KML outline is traced straight out of it.
		return {
			level: level, cell: cell, cells: cells, area: area, source: source,
			mask: mask, width: width, cube: cube,
		};
	}

	// ------------------------------------------------------- coverage from points

	/** Byte layout of the position attribute inside one stored point record. */
	function positionLayout(metadata) {
		let offset = 0;
		let found = -1;
		let stride = 0;
		for (const attribute of metadata.attributes || []) {
			if (attribute.name === "position") {
				if (attribute.type !== "int32" || attribute.numElements !== 3) {
					return null;
				}
				found = offset;
			}
			offset += attribute.size;
			stride = offset;
		}
		return found < 0 ? null : { offset: found, stride: stride };
	}

	/**
	 * The plan-view coverage mask, built from real point positions.
	 *
	 * The node-cube mask this replaces cannot resolve shape finer than its
	 * coarsest childless node, and at a sparse fringe that is very coarse: a 40 m
	 * leaf straddling the edge of a lake marks the lake as covered. No outline
	 * traced from it can be trusted.
	 *
	 * Real positions fix it without reading the whole cloud, because potree's
	 * coarse levels are not a coarse *region* - each one is a thinned copy of the
	 * entire cloud, at a known spacing that halves every level. So reading levels
	 * 0..k gives complete coverage at spacing/2^k, and a handful of nodes is
	 * enough to fill a mask several hundred cells across.
	 */
	function coverageFromPoints(metadata, url, hierarchy, cube, tight) {
		// The brotli encoding needs potree's own decoder; only the default layout
		// can be read straight off the disk.
		if (metadata.encoding !== "DEFAULT" || !metadata.spacing) {
			return null;
		}
		const layout = positionLayout(metadata);
		if (!layout) {
			return null;
		}

		const deepestPresent = hierarchy.byLevel.length - 1;
		let chosen = null;

		for (let level = Math.min(COVERAGE_TARGET_LEVEL, MASK_MAX_LEVEL);
				level >= 4 && !chosen; level--) {
			const cell = cube.side / (1 << level);

			// Read down to the level whose point spacing is fine enough that a cell
			// covered by surface reliably contains several points.
			let depth = 0;
			while (metadata.spacing / (1 << depth) > cell / COVERAGE_SPACING_MARGIN) {
				depth++;
			}
			if (depth > deepestPresent) {
				continue;
			}

			let nodes = 0;
			let points = 0;
			for (let k = 0; k <= depth; k++) {
				for (const node of hierarchy.byLevel[k] || []) {
					nodes++;
					points += node.numPoints;
				}
			}
			if (nodes > 0 && nodes <= COVERAGE_MAX_NODES && points <= COVERAGE_MAX_POINTS) {
				chosen = {
					level: level, cell: cell, depth: depth, nodes: nodes, points: points,
				};
			}
		}

		if (!chosen) {
			return null;
		}

		const fs = require("fs");
		const width = 1 << chosen.level;
		const mask = new Uint8Array(width * width);
		const scale = metadata.scale;
		const offset = metadata.offset;

		let fd = null;
		try {
			fd = fs.openSync(siblingPath(url, "octree.bin"), "r");

			for (let k = 0; k <= chosen.depth; k++) {
				for (const node of hierarchy.byLevel[k] || []) {
					const buffer = Buffer.allocUnsafe(node.byteSize);
					fs.readSync(fd, buffer, 0, node.byteSize, node.byteOffset);
					const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

					for (let i = 0; i < node.numPoints; i++) {
						const at = i * layout.stride + layout.offset;
						const x = view.getInt32(at, true) * scale[0] + offset[0];
						const y = view.getInt32(at + 4, true) * scale[1] + offset[1];

						const ix = Math.floor((x - cube.minX) / chosen.cell);
						const iy = Math.floor((y - cube.minY) / chosen.cell);
						if (ix >= 0 && iy >= 0 && ix < width && iy < width) {
							mask[iy * width + ix] = 1;
						}
					}
				}
			}
		} catch (e) {
			return null;
		} finally {
			if (fd !== null) {
				try { fs.closeSync(fd); } catch (e) { /* already gone */ }
			}
		}

		const closed = closeMask(mask, width);
		const footprint = measureMask(closed, width, chosen.level, cube, tight,
			"point positions");
		footprint.nodesRead = chosen.nodes;
		footprint.pointsRead = chosen.points;
		footprint.levelsRead = chosen.depth;
		return footprint;
	}

	/**
	 * A morphological close - dilate, then erode - over the 3x3 neighbourhood.
	 *
	 * A thinned point set leaves the odd covered cell empty by chance, and a
	 * one-cell hole in the mask would come out of the trace as a one-cell hole in
	 * the KML. A false gap in a coverage report is worse than a missing one, so
	 * single-cell speckle is closed up. Real gaps larger than a cell survive.
	 */
	function closeMask(mask, width) {
		const dilated = new Uint8Array(width * width);
		for (let y = 0; y < width; y++) {
			for (let x = 0; x < width; x++) {
				if (mask[y * width + x] === 0) {
					continue;
				}
				const y0 = Math.max(0, y - 1);
				const y1 = Math.min(width - 1, y + 1);
				const x0 = Math.max(0, x - 1);
				const x1 = Math.min(width - 1, x + 1);
				for (let ny = y0; ny <= y1; ny++) {
					for (let nx = x0; nx <= x1; nx++) {
						dilated[ny * width + nx] = 1;
					}
				}
			}
		}

		const eroded = new Uint8Array(width * width);
		for (let y = 0; y < width; y++) {
			for (let x = 0; x < width; x++) {
				if (dilated[y * width + x] === 0) {
					continue;
				}
				let all = true;
				for (let ny = y - 1; ny <= y + 1 && all; ny++) {
					for (let nx = x - 1; nx <= x + 1 && all; nx++) {
						if (nx < 0 || ny < 0 || nx >= width || ny >= width ||
								dilated[ny * width + nx] === 0) {
							all = false;
						}
					}
				}
				if (all) {
					eroded[y * width + x] = 1;
				}
			}
		}

		return eroded;
	}

	// --------------------------------------------------------- footprint outline

	/**
	 * Traces the occupied cells of a mask into closed rings that run along cell
	 * edges. Every boundary is found, so a cloud in two pieces gives two outer
	 * rings and a lake in the middle gives a ring of its own.
	 *
	 * Edges are oriented so the occupied cell is always on the left. That makes
	 * outer rings come out counter-clockwise and holes clockwise, which is how
	 * they get told apart afterwards - no containment test needed for that part.
	 */
	function traceRings(mask, width) {
		const occupied = (x, y) =>
			x >= 0 && y >= 0 && x < width && y < width && mask[y * width + x] === 1;

		const edges = new Map();
		const addEdge = (fromX, fromY, toX, toY) => {
			const key = fromX + "," + fromY;
			const list = edges.get(key);
			if (list) {
				list.push([toX, toY]);
			} else {
				edges.set(key, [[toX, toY]]);
			}
		};

		for (let y = 0; y < width; y++) {
			for (let x = 0; x < width; x++) {
				if (!occupied(x, y)) {
					continue;
				}
				if (!occupied(x, y - 1)) { addEdge(x, y, x + 1, y); }
				if (!occupied(x + 1, y)) { addEdge(x + 1, y, x + 1, y + 1); }
				if (!occupied(x, y + 1)) { addEdge(x + 1, y + 1, x, y + 1); }
				if (!occupied(x - 1, y)) { addEdge(x, y + 1, x, y); }
			}
		}

		const rings = [];
		while (edges.size > 0) {
			const start = edges.keys().next().value.split(",").map(Number);
			const ring = [[start[0], start[1]]];
			let x = start[0];
			let y = start[1];
			let direction = null;

			for (;;) {
				const key = x + "," + y;
				const list = edges.get(key);
				if (!list || list.length === 0) {
					break;
				}

				// Two cells touching only at a corner leave that lattice point with
				// two ways out. Taking the sharpest right turn treats the cells as
				// four-connected, which keeps the two regions as separate rings
				// instead of joining them through a zero-width neck.
				const index = (list.length > 1 && direction)
					? sharpestRight(list, x, y, direction) : 0;

				const next = list.splice(index, 1)[0];
				if (list.length === 0) {
					edges.delete(key);
				}

				direction = [next[0] - x, next[1] - y];
				x = next[0];
				y = next[1];
				ring.push([x, y]);

				if (x === ring[0][0] && y === ring[0][1]) {
					break;
				}
			}

			if (ring.length > 3) {
				rings.push(ring);
			}
		}

		return rings;
	}

	function sharpestRight(list, x, y, direction) {
		const wanted = [
			[direction[1], -direction[0]],     // right
			[direction[0], direction[1]],      // straight on
			[-direction[1], direction[0]],     // left
			[-direction[0], -direction[1]],    // back
		];
		for (const want of wanted) {
			for (let i = 0; i < list.length; i++) {
				if (list[i][0] - x === want[0] && list[i][1] - y === want[1]) {
					return i;
				}
			}
		}
		return 0;
	}

	/** Positive for a counter-clockwise ring, negative for a clockwise one. */
	function signedArea(ring) {
		let sum = 0;
		for (let i = 0; i < ring.length - 1; i++) {
			sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
		}
		return sum / 2;
	}

	function insideRing(point, ring) {
		let inside = false;
		for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
			const yi = ring[i][1];
			const yj = ring[j][1];
			if ((yi > point[1]) !== (yj > point[1]) &&
					point[0] < (ring[j][0] - ring[i][0]) * (point[1] - yi) / (yj - yi) + ring[i][0]) {
				inside = !inside;
			}
		}
		return inside;
	}

	/**
	 * A point strictly inside the empty region a clockwise ring encloses. The
	 * occupied side is on the left of each edge, so the hole is on the right -
	 * a quarter cell that way from an edge midpoint is inside it.
	 */
	function pointInsideHole(ring) {
		const from = ring[0];
		const to = ring[1];
		const dx = to[0] - from[0];
		const dy = to[1] - from[1];
		return [
			(from[0] + to[0]) / 2 + 0.25 * dy,
			(from[1] + to[1]) / 2 - 0.25 * dx,
		];
	}

	/** Drops the middle of any three points in a straight line. Lossless. */
	function dropCollinear(ring) {
		const kept = [ring[0]];
		for (let i = 1; i < ring.length - 1; i++) {
			const a = kept[kept.length - 1];
			const b = ring[i];
			const c = ring[i + 1];
			const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
			if (cross !== 0) {
				kept.push(b);
			}
		}
		kept.push(ring[ring.length - 1]);
		return kept;
	}

	/**
	 * Douglas-Peucker, iterative because a ring can carry thousands of points and
	 * the recursive form would run the stack out on the worst-case shape.
	 */
	function simplifyRing(ring, epsilon) {
		if (ring.length < 4) {
			return ring;
		}

		const keep = new Uint8Array(ring.length);
		keep[0] = 1;
		keep[ring.length - 1] = 1;

		const stack = [[0, ring.length - 1]];
		while (stack.length > 0) {
			const span = stack.pop();
			const first = span[0];
			const last = span[1];
			if (last <= first + 1) {
				continue;
			}

			const ax = ring[first][0];
			const ay = ring[first][1];
			const bx = ring[last][0];
			const by = ring[last][1];
			const dx = bx - ax;
			const dy = by - ay;
			const length = Math.sqrt(dx * dx + dy * dy);

			let worst = -1;
			let worstAt = -1;
			for (let i = first + 1; i < last; i++) {
				const px = ring[i][0];
				const py = ring[i][1];
				const distance = length === 0
					? Math.hypot(px - ax, py - ay)
					: Math.abs(dy * (px - ax) - dx * (py - ay)) / length;
				if (distance > worst) {
					worst = distance;
					worstAt = i;
				}
			}

			if (worst > epsilon) {
				keep[worstAt] = 1;
				stack.push([first, worstAt]);
				stack.push([worstAt, last]);
			}
		}

		const kept = [];
		for (let i = 0; i < ring.length; i++) {
			if (keep[i]) {
				kept.push(ring[i]);
			}
		}
		return kept;
	}

	/**
	 * The traced mask as polygons in world coordinates: an outer ring each, with
	 * whichever holes fall inside them. Rings are simplified to about a cell,
	 * which turns the staircase the mask necessarily produces into the rough
	 * outline it is standing in for.
	 */
	function footprintPolygons(footprint, cube, tight) {
		const rings = traceRings(footprint.mask, footprint.width);
		if (rings.length === 0) {
			return null;
		}

		const toWorld = (ring) => ring.map((point) => {
			let x = cube.minX + point[0] * footprint.cell;
			let y = cube.minY + point[1] * footprint.cell;
			if (tight) {
				// Cells overhang the last point by up to their own size; the cloud
				// cannot reach past its own bounding box, so clamp it back.
				x = Math.min(Math.max(x, tight.minX), tight.maxX);
				y = Math.min(Math.max(y, tight.minY), tight.maxY);
			}
			return [x, y];
		});

		let epsilon = footprint.cell;
		let outers = [];
		let holes = [];
		let vertices = 0;

		for (let attempt = 0; attempt < 6; attempt++) {
			outers = [];
			holes = [];
			vertices = 0;

			for (const ring of rings) {
				const world = simplifyRing(dropCollinear(toWorld(ring)), epsilon);
				if (world.length < 4) {
					continue;
				}
				vertices += world.length;
				if (signedArea(ring) > 0) {
					outers.push(world);
				} else {
					holes.push({ ring: world, sample: toWorld([pointInsideHole(ring)])[0] });
				}
			}

			if (vertices <= OUTLINE_MAX_VERTICES) {
				break;
			}
			// Too much for one KML to be worth opening - coarsen and try again.
			epsilon *= 2;
		}

		if (outers.length === 0) {
			return null;
		}

		const polygons = outers.map((outer) => ({
			outer: outer,
			holes: [],
			area: Math.abs(signedArea(outer)),
		}));

		for (const hole of holes) {
			let best = null;
			for (const polygon of polygons) {
				if (insideRing(hole.sample, polygon.outer) &&
						(best === null || polygon.area < best.area)) {
					best = polygon;
				}
			}
			// A hole with no parent means the containment test disagreed with the
			// winding - drop it rather than emit a ring that would render as land.
			if (best) {
				best.holes.push(hole.ring);
			}
		}

		polygons.sort((a, b) => b.area - a.area);

		return {
			polygons: polygons,
			vertices: vertices,
			epsilon: epsilon,
			holes: polygons.reduce((total, polygon) => total + polygon.holes.length, 0),
		};
	}

	/**
	 * Walks a potree 2.0 hierarchy.bin off disk, mirroring NodeLoader's record
	 * layout, and returns the childless nodes. Reading the file rather than the
	 * live octree keeps this free of any interaction with potree's loader: a
	 * report can never disturb what is on screen.
	 */
	function potreeFrontier(metadata, buffer) {
		const BYTES_PER_NODE = 22;
		const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

		const root = {
			level: 0, ix: 0, iy: 0, nodeType: 2,
			chunkOffset: 0, chunkSize: metadata.hierarchy.firstChunkSize,
		};

		const chunks = [root];
		const frontier = [];
		const byLevel = [];
		const started = performance.now();
		let visited = 1;
		let truncated = false;

		while (chunks.length > 0) {
			const chunk = chunks.shift();
			const count = Math.floor(chunk.chunkSize / BYTES_PER_NODE);
			if (chunk.chunkOffset + chunk.chunkSize > buffer.byteLength) {
				truncated = true;
				continue;
			}

			// Records inside a chunk are in the order this queue fills, so every
			// record has to be read even when we do not care about the node -
			// skipping one would shift every record after it onto the wrong node.
			const nodes = new Array(count);
			nodes[0] = chunk;
			let next = 1;

			for (let i = 0; i < count; i++) {
				const current = nodes[i];
				if (!current) {
					truncated = true;
					break;
				}

				const base = chunk.chunkOffset + i * BYTES_PER_NODE;
				const type = view.getUint8(base);
				const childMask = view.getUint8(base + 1);
				const numPoints = view.getUint32(base + 2, true);
				const byteSize = Number(view.getBigInt64(base + 14, true));

				const wasProxy = current.nodeType === 2;
				current.nodeType = type;

				if (!wasProxy && type === 2) {
					// A proxy: its subtree lives in its own chunk, and none of its
					// children appear in this one.
					current.chunkOffset = Number(view.getBigInt64(base + 6, true));
					current.chunkSize = byteSize;
					if (visited < HIERARCHY_MAX_NODES &&
							performance.now() - started < HIERARCHY_BUDGET_MS) {
						chunks.push(current);
					} else {
						frontier.push(current);
						truncated = true;
					}
					continue;
				}

				// A real record. The #1125 workaround: a zero byteSize means the
				// reported point count is not real, so the node holds nothing.
				const hasPoints = numPoints > 0 && byteSize > 0;
				if (hasPoints) {
					current.byteOffset = Number(view.getBigInt64(base + 6, true));
					current.byteSize = byteSize;
					current.numPoints = numPoints;
					if (!byLevel[current.level]) {
						byLevel[current.level] = [];
					}
					byLevel[current.level].push(current);
				}

				if (childMask === 0) {
					if (hasPoints) {
						frontier.push(current);
					}
					continue;
				}

				for (let childIndex = 0; childIndex < 8; childIndex++) {
					if (((1 << childIndex) & childMask) === 0) {
						continue;
					}
					nodes[next] = {
						level: current.level + 1,
						// createChildAABB splits z on bit 0, y on bit 1, x on bit 2.
						ix: current.ix * 2 + ((childIndex >> 2) & 1),
						iy: current.iy * 2 + ((childIndex >> 1) & 1),
						nodeType: 0,
					};
					next++;
					visited++;
				}
			}
		}

		return {
			frontier: frontier, byLevel: byLevel,
			truncated: truncated, nodes: visited,
		};
	}

	/** The same idea over a COPC hierarchy, whose pages name nodes by key. */
	async function copcFrontier(copc, getter) {
		const { Copc, Key } = window.Copc;

		const points = new Map();
		const pages = [copc.info.rootHierarchyPage];
		const started = performance.now();
		let truncated = false;

		while (pages.length > 0) {
			const page = pages.shift();
			const result = await Copc.loadHierarchyPage(getter, page);

			for (const key of Object.keys(result.nodes)) {
				points.set(key, result.nodes[key].pointCount);
			}
			for (const key of Object.keys(result.pages)) {
				if (points.size < HIERARCHY_MAX_NODES &&
						performance.now() - started < HIERARCHY_BUDGET_MS) {
					pages.push(result.pages[key]);
				} else {
					// Cannot see inside it - treat the page root as a leaf.
					points.set(key, points.get(key) || 1);
					truncated = true;
				}
			}
		}

		const frontier = [];
		for (const key of points.keys()) {
			if (points.get(key) <= 0) {
				continue;
			}
			const parsed = Key.create(key);
			const depth = parsed[0];
			const x = parsed[1];
			const y = parsed[2];
			const z = parsed[3];

			let hasChild = false;
			for (let index = 0; index < 8 && !hasChild; index++) {
				const child = `${depth + 1}-${x * 2 + ((index >> 2) & 1)}-` +
					`${y * 2 + ((index >> 1) & 1)}-${z * 2 + (index & 1)}`;
				hasChild = points.has(child);
			}
			if (!hasChild) {
				frontier.push({ level: depth, ix: x, iy: y });
			}
		}

		return { frontier: frontier, truncated: truncated, nodes: points.size };
	}

	function writeDensity(out, points, tight, footprint, angular) {
		out.section("average point density", { wide: true });

		if (!points) {
			out.prose("The file does not record a point count.");
			return;
		}
		out.kv("Points", commas(points));

		if (tight) {
			const area = tight.dx * tight.dy;
			out.kv("Bounding-box footprint",
				`${num(tight.dx, 1)} x ${num(tight.dy, 1)} m = ${num(area, 0)} m2` +
				`   ->   ${num(points / area, 1)} pts/m2`);
		}

		if (footprint && footprint.area > 0) {
			out.kv("Occupied footprint",
				`${num(footprint.area, 0)} m2 ` +
				`(${num(footprint.cell, 3)} m cells)` +
				`   ->   ${num(points / footprint.area, 1)} pts/m2`);
			out.indented("measured from", footprint.source);
			if (footprint.pointsRead) {
				out.indented("read", `${commas(footprint.pointsRead)} points in ` +
					`${commas(footprint.nodesRead)} nodes, octree levels 0-${footprint.levelsRead}`);
			}
			if (footprint.truncated) {
				out.indented("note",
					"the octree walk hit its budget, so the area is coarser than it could be");
			}
		} else {
			out.kv("Occupied footprint", "(could not be worked out from the hierarchy)");
		}

		if (angular) {
			out.prose("WARNING: this cloud's coordinate system is geographic, so its " +
				"units are degrees, not metres. Every figure above that says m or m2 is " +
				"meaningless for it. Reproject to a projected system before reading any " +
				"density off this report.");
		}

		out.prose("The bounding-box figure divides the point count by the whole plan " +
			"rectangle, so it collapses whenever the cloud does not fill it - a " +
			"corridor, a diagonal strip, an L-shaped block, anything with a lake in " +
			"the middle. The occupied figure counts only the cells that hold points, " +
			"so it is the one to read on any shape that is not a filled rectangle.");
		out.prose("Both are still estimates, accurate to about a cell around the edges " +
			"of the cloud and of any gap in it, and both are whole-cloud averages. A " +
			"delivery is judged per cell: use Density colouring for that, or the " +
			"density probe for one spot.");
	}

	// ------------------------------------------------------------------- report

	/**
	 * Which files on disk hold a LAS public header for this cloud. A dropped
	 * .copc.laz is itself one; a converted octree records what it came from in
	 * qc_source.json, written by the converter panel.
	 */
	function sourceFiles(url, isCopc) {
		const found = [];

		if (isCopc && url) {
			return [{ path: url, label: "copc file" }];
		}
		if (!url) {
			return found;
		}

		try {
			const fs = require("fs");
			// A hand-edited manifest can arrive with a byte order mark, and
			// JSON.parse will not have it. Left in, this fails silently: the whole
			// source section just never appears.
			const manifest = JSON.parse(
				fs.readFileSync(siblingPath(url, "qc_source.json"), "utf8")
					.replace(/^﻿/, ""));
			for (const path of manifest.source || []) {
				found.push({
					path: path,
					label: manifest.source.length > 1
						? `source file: ${require("path").basename(path)}`
						: "source file (before conversion)",
				});
			}
		} catch (e) {
			// No manifest: an octree converted before this existed, or by another
			// tool. Nothing to add - the potree metadata already stands alone.
		}

		return found;
	}

	/** Everything known about one loaded point cloud. */
	async function reportFor(pointcloud, out) {
		const geometry = pointcloud.pcoGeometry;
		const url = geometry ? geometry.url : null;

		out.cloud(pointcloud.name || "(unnamed)");
		out.section("in the viewer");
		out.kv("Visible", pointcloud.visible ? "yes" : "no (hidden in the scene)");
		out.kv("Active attribute", pointcloud.material
			? pointcloud.material.activeAttributeName : "-");

		const metadata = geometry && geometry.loader ? geometry.loader.metadata : null;
		const isCopc = geometry && geometry.type === "copc";
		const isEpt = geometry && geometry.type === "ept";

		let points = null;
		let tight = null;
		let footprint = null;
		let cube = null;
		let wkt = null;
		let geotiff = null;

		if (metadata && metadata.attributes) {
			writePotreeSection(out, metadata, url);

			points = metadata.points;
			const position = metadata.attributes.find((a) => a.name === "position");
			if (position) {
				tight = tightRect(position.min, position.max);
			}
			if (metadata.boundingBox) {
				cube = {
					minX: metadata.boundingBox.min[0],
					minY: metadata.boundingBox.min[1],
					side: metadata.boundingBox.max[0] - metadata.boundingBox.min[0],
				};
			}

			if (url && cube && metadata.hierarchy) {
				try {
					const buffer = require("fs").readFileSync(siblingPath(url, "hierarchy.bin"));
					const walk = potreeFrontier(metadata, buffer);
					// Real positions where they can be read, node cubes only if not.
					footprint = coverageFromPoints(metadata, url, walk, cube, tight) ||
						rasterize(walk.frontier, cube, tight);
					if (footprint) {
						footprint.truncated = walk.truncated;
					}
				} catch (e) {
					out.kv("hierarchy.bin", `could not be read: ${e.message}`);
				}
			}
		} else if (isCopc && geometry.copc) {
			const copc = geometry.copc;
			points = copc.header.pointCount;
			tight = tightRect(copc.header.min, copc.header.max);
			cube = copcCube(copc);
			wkt = copc.wkt || null;

			// With a path, the file is re-read below and every record comes out
			// decoded. Without one - loaded by something that did not record it -
			// this is what the loader kept, which is still most of it.
			if (!url) {
				out.section("copc file");
				out.kv("File", "(the path was not recorded when this cloud was loaded)");
				writeHeader(out, copc.header, copc);
				writeVlrs(out, copc.vlrs);
				if (copc.wkt) {
					out.section("wkt", { wide: true });
					const crs = crsFromWkt(copc.wkt);
					if (crs) {
						out.kv("Authority", crs.label);
					}
					out.pre(copc.wkt);
				}
				writeCopcInfo(out, copc);
				writeExtraBytes(out, copc.eb);
			}
		} else if (isEpt && geometry.ept) {
			out.section("ept metadata", { wide: true });
			out.pre(JSON.stringify(geometry.ept, null, 2));
			points = geometry.ept.points;
		} else {
			out.section("source", { wide: true });
			out.kv("File", url || "(not recorded)");
			out.prose("This is not a potree 2.0 octree, a COPC file or an EPT dataset, " +
				"so there is no metadata block to report. Potree 1.7 clouds carry their " +
				"information in cloud.js.");
			if (url) {
				try {
					out.pre(require("fs").readFileSync(url, "utf8"));
				} catch (e) { /* nothing more to say */ }
			}
		}

		// A file the viewer read directly - a dropped .copc.laz, or the LAS/LAZ a
		// converted octree came from - has a public header worth reporting in full.
		for (const source of sourceFiles(url, isCopc)) {
			const result = await lasSection(out, source.path, source.label);
			if (!result) {
				continue;
			}

			wkt = wkt || result.wkt;
			geotiff = geotiff || result.geotiff;
			if (!points) {
				points = result.header.pointCount;
			}
			if (!tight) {
				tight = tightRect(result.header.min, result.header.max);
			}
			if (result.copc && !footprint) {
				try {
					const walk = await copcFrontier(result.copc, result.getter);
					footprint = rasterize(walk.frontier, cube || copcCube(result.copc), tight);
					if (footprint) {
						footprint.truncated = walk.truncated;
					}
				} catch (e) {
					out.kv("COPC hierarchy", `could not be walked: ${e.message}`);
				}
			}
			result.getter.close();
		}

		const crs = (wkt ? crsFromWkt(wkt) : null) || geotiff;
		const angular = !!(crs && !crs.projected);

		// Location first: it is a compact card, so it pairs with the header cards
		// above it, and the density prose reads better as the closing block.
		writeLocation(out, pointcloud.name, wkt, crs, metadata, tight, points, footprint);
		writeDensity(out, points, tight, footprint, angular);
	}

	/**
	 * Where on the earth this is, if the file says. A cloud with no CRS still
	 * gets the section, saying so - "the file does not record one" is a real QC
	 * finding, not an absence worth hiding.
	 */
	function writeLocation(out, name, wkt, crs, metadata, tight, points, footprint) {
		out.section("location on the earth");

		const projection = projectionFor(wkt, crs ? crs.epsg : null,
			metadata && metadata.projection ? metadata.projection : null);

		out.kv("Coordinate system", crs ? crs.label : "(the files do not record one)");

		if (!projection) {
			out.kv("Can be placed", "no");
			out.prose(crs
				? "The system is named but could not be turned into a transform. proj4 " +
					"reads a WKT PROJCS node and UTM zones by EPSG code; anything else " +
					"needs its definition registered."
				: "Without a coordinate system the numbers are just numbers - there is no " +
					"way to say where the survey was flown or driven.");
			return;
		}

		if (!tight) {
			out.kv("Can be placed", "no - the extent is not known");
			return;
		}

		const place = placeFor(name, tight, footprint, projection, crs, points);
		if (!place) {
			out.kv("Can be placed", "no");
			out.prose("The extent does not transform to sensible lon/lat - the " +
				"coordinates are probably not in the system the file names.");
			return;
		}

		out.kv("Transform from", projection.from);
		out.kv("Centre (lat, lon)",
			`${place.centre[1].toFixed(6)}, ${place.centre[0].toFixed(6)}`);
		out.kv("North / south",
			`${place.bounds.north.toFixed(6)} / ${place.bounds.south.toFixed(6)}`);
		out.kv("West / east",
			`${place.bounds.west.toFixed(6)} / ${place.bounds.east.toFixed(6)}`);

		if (place.traced) {
			out.kv("Outline", `traced from ${footprint.source}, ` +
				`${num(footprint.cell, 3)} m cells`);
			out.kv("Shape", `${place.polygons.length} ` +
				`${place.polygons.length === 1 ? "area" : "separate areas"}, ` +
				`${place.holes} ${place.holes === 1 ? "hole" : "holes"}`);
			out.kv("Vertices", commas(place.vertices));
			out.prose("The button at the top writes this outline to a KML and opens it " +
				"in Google Earth, so you can see where the data was captured. It is the " +
				"real coverage, not the bounding box: separate blocks come out as " +
				"separate areas, and a lake or a gap in the data comes out as a hole in " +
				"the shape.");
			out.prose(`The outline is traced around the cells that hold points, so it ` +
				`is accurate to about one ${num(footprint.cell, 1)} m cell and cannot ` +
				`show a gap smaller than that.`);
			if (footprint.source !== "point positions") {
				out.prose("This one was traced from octree node cubes rather than from " +
					"point positions, because the point data could not be read - a brotli " +
					"encoded octree, or a COPC file. A node cube is only as fine as the " +
					"shallowest childless node, so the shape is blocky and a gap smaller " +
					"than a coarse node can be filled in rather than shown. Treat it as " +
					"indicative.");
			}
		} else {
			out.kv("Outline", "the bounding box - no octree footprint to trace");
			out.prose("The button at the top writes the extent to a KML and opens it in " +
				"Google Earth. With no octree to trace, this is the bounding box, walked " +
				"edge by edge rather than corner to corner because a projected rectangle " +
				"is not a rectangle in lon/lat.");
		}

		out.place(place);
	}

	/** Transforms a cloud's footprint to lon/lat and packages it for the KML. */
	function placeFor(name, tight, footprint, projection, crs, points) {
		const toLonLat = (ring) => {
			const result = [];
			for (const point of ring) {
				try {
					const lonLat = projection.transform.forward([point[0], point[1]]);
					if (!isFinite(lonLat[0]) || !isFinite(lonLat[1]) ||
							Math.abs(lonLat[0]) > 180 || Math.abs(lonLat[1]) > 90) {
						return null;
					}
					result.push([lonLat[0], lonLat[1]]);
				} catch (e) {
					return null;
				}
			}
			return result;
		};

		let polygons = null;
		let traced = false;
		let vertices = 0;
		let holes = 0;

		const shape = (footprint && footprint.mask)
			? footprintPolygons(footprint, footprint.cube, tight) : null;

		if (shape) {
			const projected = [];
			for (const polygon of shape.polygons) {
				const outer = toLonLat(polygon.outer);
				if (!outer) {
					continue;
				}
				const inner = polygon.holes.map(toLonLat).filter(Boolean);
				projected.push({ outer: outer, holes: inner });
				vertices += outer.length + inner.reduce((t, r) => t + r.length, 0);
				holes += inner.length;
			}
			if (projected.length > 0) {
				polygons = projected;
				traced = true;
			}
		}

		if (!polygons) {
			const box = outlineOf(tight, projection);
			if (!box) {
				return null;
			}
			polygons = [{ outer: box, holes: [] }];
			vertices = box.length;
		}

		let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
		for (const polygon of polygons) {
			for (const point of polygon.outer) {
				west = Math.min(west, point[0]);
				east = Math.max(east, point[0]);
				south = Math.min(south, point[1]);
				north = Math.max(north, point[1]);
			}
		}

		return {
			name: name || "Point cloud",
			polygons: polygons,
			traced: traced,
			vertices: vertices,
			holes: holes,
			centre: [(west + east) / 2, (south + north) / 2],
			bounds: { west: west, east: east, south: south, north: north },
			extent: tight,
			points: points,
			crs: crs ? crs.label : null,
			source: projection.from,
			cell: footprint ? footprint.cell : null,
		};
	}

	async function buildReport(viewer) {
		const out = document_();
		const clouds = viewer.scene.pointclouds;

		out.meta("Generated", stamp(new Date()));
		out.meta("Point clouds loaded", clouds.length);
		out.note("Everything below is read from the files, not from what is drawn, so " +
			"clips and filters do not change any of it.");

		for (const pointcloud of clouds) {
			try {
				await reportFor(pointcloud, out);
			} catch (e) {
				out.section("failed");
				out.kv("Reporting this cloud failed", e && e.message ? e.message : String(e));
				out.pre(e && e.stack ? e.stack : String(e));
			}
		}

		return out.model;
	}

	/** The LAS/COPC half of the report for any file on disk, loaded or not. */
	async function reportFile(path) {
		const out = document_();
		out.meta("Generated", stamp(new Date()));
		out.cloud(require("path").basename(path));

		const result = await lasSection(out, path, "las / laz / copc file");
		if (!result) {
			return out.model;
		}

		const tight = tightRect(result.header.min, result.header.max);
		const crs = (result.wkt ? crsFromWkt(result.wkt) : null) || result.geotiff;

		let footprint = null;
		if (result.copc) {
			try {
				const walk = await copcFrontier(result.copc, result.getter);
				footprint = rasterize(walk.frontier, copcCube(result.copc), tight);
				if (footprint) {
					footprint.truncated = walk.truncated;
				}
			} catch (e) {
				out.kv("COPC hierarchy", `could not be walked: ${e.message}`);
			}
		}

		writeLocation(out, require("path").basename(path), result.wkt, crs, null,
			tight, result.header.pointCount, footprint);
		writeDensity(out, result.header.pointCount, tight, footprint,
			!!(crs && !crs.projected));

		result.getter.close();
		return out.model;
	}

	// -------------------------------------------------------------------- popup

	/**
	 * A separate window holding the report. The only script involved is the one
	 * this side of the boundary: the page itself has none, so selection, Ctrl+A
	 * and Ctrl+C are the browser's own and copying is what is on screen. The
	 * toolbar is user-select: none, so a select-all skips it.
	 *
	 * It has to be a separate window rather than a panel, because potree.css sets
	 * user-select: none on the sidebar and the render area. main.js strips the
	 * menu off it - see the did-create-window handler there.
	 */
	function showReport(title, model) {
		const popup = window.open("", "qc_pointcloud_info",
			"width=1180,height=880,resizable=yes,scrollbars=yes");

		if (!popup) {
			showFallbackPanel(title, toText(model));
			return null;
		}

		popup.document.open();
		popup.document.write(toHtml(model, title));
		popup.document.close();
		popup.focus();

		// Wired from here rather than from a script in the page, so the page stays
		// script-free and the handler keeps this window's require().
		const button = popup.document.getElementById("qc_earth");
		if (button && model.places.length > 0) {
			button.onclick = () => {
				try {
					const result = openInGoogleEarth(model.places);
					button.textContent = `Opened in ${result.opened}`;
					popup.setTimeout(() => {
						button.textContent = earthButtonLabel(model.places.length);
					}, 4000);
				} catch (e) {
					button.textContent = `Failed: ${e.message}`;
					console.error(e);
				}
			};
		}

		return popup;
	}

	/** If the window could not be opened, keep the report reachable in-page. */
	function showFallbackPanel(title, text) {
		$("#qc_info_overlay").remove();

		const overlay = $(`
			<div id="qc_info_overlay" class="qc-info-overlay">
				<div class="qc-info-bar">
					<span></span>
					<span class="qc-info-close" title="Close">&#10005;</span>
				</div>
				<pre class="qc-info-text"></pre>
			</div>
		`);

		overlay.find(".qc-info-bar span").first().text(title);
		overlay.find(".qc-info-text").text(text);
		overlay.find(".qc-info-close").click(() => overlay.remove());

		$("body").append(overlay);
	}

	// -------------------------------------------------------------------- panel

	function install(ctx, panel) {
		const viewer = ctx.viewer;

		panel.append($(`
			<div class="divider"><span>File info</span></div>
			<li><input id="qc_info_run" type="button" value="Point cloud info"
				style="width: 100%"/></li>
			<li id="qc_info_status" class="qc-status">&nbsp;</li>
			<li class="qc-dim">Header, records, coordinate system, attribute ranges
				and average points/m&sup2;, as text you can select and copy. Opens with
				a button to show the extent in Google Earth.</li>
		`));

		const elRun = panel.find("#qc_info_run");
		const elStatus = panel.find("#qc_info_status");
		const setStatus = (text) => elStatus.html(text || "&nbsp;");

		let busy = false;

		const show = async () => {
			if (busy) {
				return;
			}
			busy = true;
			elRun.prop("disabled", true);
			setStatus("Reading the files...");

			try {
				const model = await buildReport(viewer);
				const opened = showReport("Point cloud info", model);
				setStatus(opened
					? "Report opened in its own window."
					: "Report shown over the viewer.");
			} catch (e) {
				setStatus(`Failed: ${e && e.message ? e.message : e}`);
				console.error(e);
			} finally {
				busy = false;
				elRun.prop("disabled", false);
			}
		};

		elRun.click(show);

		return {
			show: show,
			report: async () => toText(await buildReport(viewer)),
			reportModel: () => buildReport(viewer),
			reportFile: async (path) => toText(await reportFile(path)),
			showFile: async (path) => {
				showReport(`File info: ${require("path").basename(path)}`,
					await reportFile(path));
			},
			openInGoogleEarth: openInGoogleEarth,
		};
	}

	window.QCFileInfo = {
		install: install,
	};
})();
