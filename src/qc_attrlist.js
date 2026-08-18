/**
 * QC Tools: colour-coding for the Appearance attribute list.
 *
 * Stock Potree lists the cloud's real point attributes and its own colouring
 * modes in one flat dropdown, so "intensity" and "intensity gradient" look
 * equally like properties of the data. They are not. This marks each entry by
 * where it comes from:
 *
 *   green   - really recorded in the point cloud
 *   purple  - a viewer colouring mode, computed rather than read
 *   yellow  - a LAS attribute Potree could colour by, absent from this cloud
 *
 * The yellow group is the reason this is worth doing: stock Potree simply omits
 * what is missing, so "no RGB in this delivery" and "RGB is there and I have not
 * scrolled to it" look identical.
 *
 * Plain script, loaded after potree.js and before qc_tools.js.
 * QCTools.install() calls QCAttrList.install().
 */
(function () {
	"use strict";

	/**
	 * Colouring modes Potree appends to every cloud regardless of its contents.
	 * Mirrors the unconditional pushes in PropertiesPanel.setPointCloud, plus
	 * "intensity gradient", which is spliced in when the cloud has intensity.
	 *
	 * Anything in the dropdown that is *not* in here came from
	 * pcoGeometry.pointAttributes.attributes, so it is genuinely in the file.
	 * Deriving it that way rather than reading the point cloud object keeps this
	 * independent of which cloud the sidebar happens to have selected.
	 */
	const VIEWER_MODES = new Set([
		"intensity gradient",
		"elevation",
		"color",
		"matcap",
		"indices",
		"level of detail",
		"composite",
	]);

	/**
	 * The LAS attributes PotreeConverter writes out and Potree can colour by.
	 * Names are the converter's, as they appear in metadata.json, not LAS spec
	 * wording. Verified against PotreeConverter 2 output for point formats
	 * 0, 1, 2, 3, 6 and 7.
	 *
	 * `aliases` exist because the extended point formats renamed things: format 6
	 * and up call it "scan angle" where 0-5 call it "scan angle rank", and
	 * "classification flags" only exists from format 6 on. Matching the whole
	 * alias set is what stops a legacy cloud reporting "scan angle" as missing
	 * when it has "scan angle rank" sitting right above it in the same list.
	 *
	 * "rgb" is here because the converter writes that name and Potree's loader
	 * renames it to "rgba" on the way in, so both spellings have to count.
	 */
	const COLOURABLE = [
		{ name: "rgba", aliases: ["rgba", "rgb"], note: "colour recorded per point" },
		{ name: "intensity", aliases: ["intensity"], note: "return strength" },
		{ name: "classification", aliases: ["classification"], note: "ground, vegetation, building and so on" },
		{ name: "classification flags", aliases: ["classification flags"], note: "synthetic, key-point, withheld, overlap" },
		{ name: "return number", aliases: ["return number"], note: "which return of the pulse this is" },
		{ name: "number of returns", aliases: ["number of returns"], note: "how many returns the pulse produced" },
		{ name: "point source id", aliases: ["point source id", "source id"], note: "which flight line or scan the point came from" },
		{ name: "gps-time", aliases: ["gps-time"], note: "when the point was captured" },
		{ name: "scan angle", aliases: ["scan angle", "scan angle rank"], note: "angle of the pulse off nadir" },
		{ name: "user data", aliases: ["user data"], note: "free byte, meaning is producer-specific" },
	];

	/**
	 * What each LAS point data record format records, in PotreeConverter's
	 * spelling where it has one. Used to work out what the source file held that
	 * the octree does not, so the dropdown can show it rather than silently
	 * omitting it.
	 *
	 * `carrier` names the octree attribute a field ends up packed inside, when it
	 * ends up anywhere at all. PotreeConverter writes `classification flags` as
	 * the low nibble of the format 6 flag byte only, measured range 0 to 15
	 * against a source where all eight bits varied, so scanner channel, scan
	 * direction and edge of flight line are lost outright. On the legacy formats
	 * the three class-flag bits live in the classification byte and are lost too.
	 */
	const CORE_FIELDS = [
		"intensity", "return number", "number of returns",
		"classification", "user data", "point source id",
		{ name: "scan direction flag" },
		{ name: "edge of flight line" },
	];

	const LEGACY_FIELDS = [
		"scan angle rank",
		{ name: "synthetic flag" },
		{ name: "key-point flag" },
		{ name: "withheld flag" },
	];

	const EXTENDED_FIELDS = [
		"scan angle", "classification flags",
		{ name: "scanner channel" },
		{ name: "synthetic flag", carrier: "classification flags" },
		{ name: "key-point flag", carrier: "classification flags" },
		{ name: "withheld flag", carrier: "classification flags" },
		{ name: "overlap flag", carrier: "classification flags" },
	];

	const FORMAT_EXTRAS = {
		gps: [1, 3, 4, 5, 6, 7, 8, 9, 10],
		rgb: [2, 3, 5, 7, 8, 10],
		nir: [8, 10],
		wave: [4, 5, 9, 10],
	};

	/**
	 * How to read a scan angle field as degrees.
	 *
	 * Point formats 6-10 store `scan angle` as a signed int16 in 0.006 degree
	 * increments, +-30000 for +-180 degrees. Formats 0-5 stored `scan angle rank`
	 * as a signed *byte* in whole degrees, +-90. Whole-degree precision belongs to
	 * the legacy field alone, which is the usual source of the confusion: Potree
	 * shows the raw stored integer, so a format 6 file reads "-6635 to 6748" for
	 * what is really -39.8 to +40.5 degrees.
	 */
	const ANGLE_UNITS = {
		"scan angle": 0.006,
		"scan angle rank": 1,
	};

	const KIND_TITLE = {
		data: "In this point cloud",
		viewer: "Viewer colouring mode, not in the data",
		missing: "Not in this point cloud",
		dropped: "In the source file, but not in the converted octree",
	};

	let installed = false;

	function install() {
		if (installed) {
			return;
		}
		installed = true;

		// The Appearance panel is rebuilt from scratch every time the sidebar
		// selection changes, and PropertiesPanel is a bundle-local class with no
		// instance reachable from outside, so there is nothing to wrap. jQuery UI
		// fires selectmenucreate on the <select> itself and Potree has already
		// appended the panel to the sidebar by then, so a delegated listener on
		// the document catches every rebuild with no patch to potree.js.
		$(document).on("selectmenucreate", "#optMaterial", function () {
			try {
				decorate($(this));
			} catch (e) {
				// A dropdown that is merely uncoloured still works. Losing the
				// Appearance panel because of a decoration would not.
				console.warn("[QC Tools] attribute list not colour-coded:", e);
			}
		});
	}

	function decorate($select) {
		if ($select.data("qcAttrList")) {
			return;
		}
		$select.data("qcAttrList", true);

		const present = new Set();

		$select.find("option").each(function () {
			const name = this.value;
			const kind = VIEWER_MODES.has(name) ? "viewer" : "data";
			if (kind === "data") {
				present.add(name);
			}
			this.setAttribute("data-qc-kind", kind);
			this.setAttribute("title", KIND_TITLE[kind]);
		});

		let missing = 0;
		for (const candidate of COLOURABLE) {
			if (candidate.aliases.some((alias) => present.has(alias))) {
				continue;
			}
			missing++;
			// Disabled rather than merely tinted: selecting it would set an
			// activeAttributeName the shader has no data for, which renders black.
			// The point of showing it at all is to say the delivery lacks it.
			$select.append($("<option></option>")
				.attr("disabled", "disabled")
				.attr("data-qc-kind", "missing")
				.attr("title", KIND_TITLE.missing + " (" + candidate.note + ")")
				.text(candidate.name));
		}

		const instance = $select.selectmenu("instance");

		// jQuery UI selectmenu hides the native <select> and renders its own <ul>,
		// so styling <option> has no visible effect. It also rebuilds that <ul>
		// on every refresh, and Potree refreshes on two material events, so
		// marking the generated items once would not survive. Carrying the class
		// through _renderItem is the only place it sticks.
		if (!instance._qcRenderItemWrapped) {
			const baseRenderItem = instance._renderItem;
			instance._renderItem = function (ul, item) {
				const li = baseRenderItem.call(this, ul, item);
				const kind = item.element.attr("data-qc-kind");
				if (kind) {
					li.addClass("qc-attr-" + kind);
				}
				return li;
			};

			const baseRefresh = instance.refresh;
			instance.refresh = function () {
				baseRefresh.apply(this, arguments);
				markButton($select);
			};

			instance._qcRenderItemWrapped = true;
		}

		// jQuery UI opens a selectmenu with collision: "none", so the menu is
		// pinned under the button and simply hangs off the bottom of the window
		// once it is tall enough. Stock Potree already came within a few pixels of
		// that on a 1100 px window, and the missing entries add up to three more
		// rows, so leaving it alone would push the tail off screen with no
		// scrollbar to reach it. "flipfit" puts it above the button when there is
		// no room below; the max-height in qc_tools.css keeps it inside the
		// viewport when there is room in neither direction.
		$select.selectmenu("option", "position",
			{ my: "left top", at: "left bottom", collision: "flipfit" });

		instance.refresh();
		const legend = addLegend($select, present.size, missing);
		useAngleUnits($select, selectedPointCloud());

		// Everything above is synchronous, because the dropdown has to be right
		// the moment it appears. What the *source* file held needs a read off
		// disk, so that group arrives a moment later.
		addDroppedGroup($select, instance, present, legend);
	}

	/**
	 * Which point cloud the Appearance panel is describing. jstree records the
	 * selection before it fires `select_node`, and Potree builds the panel from
	 * that event, so by the time the dropdown exists the selection is already
	 * readable. Falls back to the only loaded cloud, which covers the ordinary
	 * one-cloud case even if the tree is ever restructured.
	 */
	function selectedPointCloud() {
		try {
			const tree = $("#jstree_scene").jstree(true);
			for (const node of tree.get_selected(true)) {
				if (node.data && node.data.pcoGeometry) {
					return node.data;
				}
			}
		} catch (e) {
			// jstree not up yet, or restructured. Fall through.
		}

		const clouds = (window.viewer && viewer.scene && viewer.scene.pointclouds) || [];
		return clouds.length === 1 ? clouds[0] : null;
	}

	/** Every LAS field a given point data record format carries. */
	function fieldsOfFormat(pointFormat) {
		const fields = CORE_FIELDS.slice();
		fields.push(...(pointFormat >= 6 ? EXTENDED_FIELDS : LEGACY_FIELDS));

		if (FORMAT_EXTRAS.gps.includes(pointFormat)) { fields.push("gps-time"); }
		if (FORMAT_EXTRAS.rgb.includes(pointFormat)) { fields.push("rgba"); }
		if (FORMAT_EXTRAS.nir.includes(pointFormat)) { fields.push({ name: "NIR" }); }
		if (FORMAT_EXTRAS.wave.includes(pointFormat)) {
			fields.push({ name: "wave packets" });
		}

		return fields.map((f) => (typeof f === "string" ? { name: f } : f));
	}

	/**
	 * The fourth group: fields the source LAS/LAZ records that did not survive
	 * conversion. Some are dropped outright, some are packed into a byte the
	 * octree does keep; the tooltip says which. Both are shown, because the
	 * question this answers is "what is in my delivery", and an attribute you
	 * cannot reach is still a different answer from one that was never captured.
	 */
	async function addDroppedGroup($select, instance, present, legend) {
		if (!window.QCFileInfo || !window.QCFileInfo.sourceRecord) {
			return;
		}

		const pointcloud = selectedPointCloud();
		if (!pointcloud) {
			return;
		}

		let record = null;
		try {
			record = await window.QCFileInfo.sourceRecord(pointcloud);
		} catch (e) {
			record = null;
		}

		// The panel is rebuilt on every selection change and this read is not
		// instant, so the dropdown we started on may already be gone.
		if (!$select.closest("body").length) {
			return;
		}

		if (!record) {
			legend.append($(`<span class="qc-attr-note">source file not read,
				so anything the conversion dropped cannot be shown</span>`));
			return;
		}

		const fields = fieldsOfFormat(record.pointFormat)
			.concat(record.extra.map((name) => ({ name: name })));

		let added = 0;
		for (const field of fields) {
			if (present.has(field.name)) {
				continue;
			}
			// `rgb` and `scan angle rank` reach the octree under another name.
			const alias = COLOURABLE.find((c) => c.aliases.includes(field.name));
			if (alias && alias.aliases.some((a) => present.has(a))) {
				continue;
			}

			added++;
			$select.append($("<option></option>")
				.attr("disabled", "disabled")
				.attr("data-qc-kind", "dropped")
				.attr("title", field.carrier
					? `Recorded in the source file. PotreeConverter packs it into `
						+ `"${field.carrier}" rather than writing it separately, so `
						+ `colour by that and read the bits.`
					: "Recorded in the source file. PotreeConverter does not write it "
						+ "to the octree, so there is nothing here to colour by.")
				.text(field.name));
		}

		instance.refresh();

		legend.append($(`
			<span><i class="qc-attr-swatch qc-attr-dropped"></i>in the file, not converted (${added})</span>
		`));
	}

	/**
	 * Puts the Extra Attribute control into degrees when a scan angle is selected:
	 * the readout, the slider's travel, and the values it reports back.
	 *
	 * Potree has no LAS semantics, so it prints and drags whatever integer the
	 * file stores. On a point format 6 cloud that is a four-digit number nobody
	 * can aim with: a degree of scan angle is 167 slider units. Everything the
	 * user sees and touches is converted; only `material.setRange` still speaks
	 * raw, because that is what the shader consumes.
	 *
	 * Driven by a MutationObserver on the label rather than a list of events,
	 * because Potree rewrites it from several places and one signal is easier to
	 * keep honest than five.
	 */
	function useAngleUnits($select, pointcloud) {
		const label = document.querySelector("#lblExtraRange");
		if (!label || !pointcloud || typeof MutationObserver === "undefined") {
			return;
		}

		const note = $(`<div class="qc-attr-degrees"></div>`);
		$(label).closest("li").append(note);

		// "Scalar range" is Potree's generic caption for any attribute it has no
		// name for. Once the numbers beside it are degrees it is actively
		// misleading, so it is swapped for the attribute's own name and put back
		// on the way out. i18n runs once when the panel is built, so it stays.
		const caption = $(label).closest("li").find("[data-i18n='appearance.extra_range']");
		const captionText = caption.text();

		let written = null;      // the last text we put in the label, see below

		/**
		 * Rescales Potree's slider so its travel is degrees rather than raw units.
		 *
		 * Idempotent, and deliberately not guarded on "has the attribute changed".
		 * Our material listener fires from inside `updateMaterialPanel`, at the
		 * line that sets `activeAttributeName`, which is *before* the line that
		 * builds this slider. Tuning once on the attribute change therefore ran
		 * first and was overwritten a moment later, and a has-it-changed guard
		 * then blocked the repair. Comparing the scale instead heals whatever
		 * order the two run in.
		 */
		const tuneSlider = (name, perUnit) => {
			const attribute = pointcloud.getAttribute(name);
			const $slider = $("#sldExtraRange");
			if (!attribute || !$slider.length || !$slider.hasClass("ui-slider")) {
				return;
			}

			const [rawMin, rawMax] = attribute.range;
			const wanted = rawMax * perUnit;
			if (Math.abs($slider.slider("option", "max") - wanted) < 1e-9) {
				return;   // already in degrees
			}

			const current = pointcloud.material.getRange(name) || [rawMin, rawMax];

			// Re-calling .slider() on a live widget goes through _setOptions, which
			// replaces the slide callback along with the bounds. Potree's own
			// handler, which assumes raw values, goes with it.
			$slider.slider({
				range: true,
				min: rawMin * perUnit,
				max: wanted,
				step: perUnit === 1 ? 1 : 0.01,
				values: [current[0] * perUnit, current[1] * perUnit],
				slide: (event, ui) => {
					pointcloud.material.setRange(name,
						[ui.values[0] / perUnit, ui.values[1] / perUnit]);
				},
			});
		};

		const update = () => {
			// The panel is thrown away on every selection change, taking this
			// element with it, but a material listener would outlive it and
			// accumulate one per rebuild. Detachment is the cue to unhook.
			if (!note.closest("body").length) {
				pointcloud.material.removeEventListener("active_attribute_changed", update);
				return;
			}

			// Our own write, coming back round through the observer. Comparing the
			// text is enough: the raw form Potree writes never matches the degree
			// form we write, so this cannot swallow a real update.
			if (label.textContent === written) {
				return;
			}

			// The attribute has to come from the material, not from the dropdown.
			// Potree writes this label from material.getRange(activeAttributeName),
			// and the two disagree whenever the panel is mid-update: reading the
			// dropdown converted intensity's 0..65535 into "0.00 to 393.21 degrees"
			// and showed it against scan angle.
			const name = pointcloud.material.activeAttributeName;
			const perUnit = ANGLE_UNITS[name];

			if (!perUnit) {
				// Emptied, not just hidden. Potree leaves the label alone when it
				// switches to an attribute with no scalar range, so a stale reading
				// would otherwise sit there waiting to reappear against the wrong
				// attribute.
				note.text("").hide();
				caption.text(captionText);
				written = null;
				return;
			}

			caption.text(name.charAt(0).toUpperCase() + name.slice(1));

			// Safe to call on every pass: it returns immediately once the slider
			// is already in degrees, so dragging does not reset its own handles.
			tuneSlider(name, perUnit);

			const parsed = (label.textContent || "").match(/(-?[\d.]+) to (-?[\d.]+)/);
			if (!parsed) {
				return;
			}

			const rawFrom = Number(parsed[1]);
			const rawTo = Number(parsed[2]);
			written = `${(rawFrom * perUnit).toFixed(2)}° to ${(rawTo * perUnit).toFixed(2)}°`;
			label.textContent = written;
			note.text(perUnit === 1
				? `whole degrees, as stored`
				: `stored as ${Math.round(rawFrom)} to ${Math.round(rawTo)}, in 0.006° steps`
			).show();
		};

		const observer = new MutationObserver(update);
		observer.observe(label, { childList: true, characterData: true, subtree: true });

		// Switching to an attribute with no scalar range does not rewrite the
		// label, so watching it alone would miss the switch. Potree does toggle
		// the container's display every time, which makes that the reliable
		// signal. selectmenuchange only fires for a click on the dropdown, not for
		// activeAttributeName being set from script.
		const container = document.querySelector("[id='materials.extra_container']");
		if (container) {
			observer.observe(container, { attributes: true, attributeFilter: ["style"] });
		}

		$select.on("selectmenuchange", update);
		pointcloud.material.addEventListener("active_attribute_changed", update);
		update();
	}

	/** Tints the closed dropdown too, so the current choice reads without opening it. */
	function markButton($select) {
		const kind = $select.find("option:selected").attr("data-qc-kind");
		$select.selectmenu("widget")
			.removeClass("qc-attr-data qc-attr-viewer qc-attr-missing qc-attr-dropped")
			.addClass(kind ? "qc-attr-" + kind : "");
	}

	function addLegend($select, dataCount, missingCount) {
		// The panel is emptied on every rebuild, so this is always a fresh insert
		// rather than an update.
		const legend = $(`
			<div class="qc-attr-legend">
				<span><i class="qc-attr-swatch qc-attr-data"></i>in this cloud (${dataCount})</span>
				<span><i class="qc-attr-swatch qc-attr-viewer"></i>viewer mode</span>
				<span><i class="qc-attr-swatch qc-attr-missing"></i>not in this cloud (${missingCount})</span>
			</div>
		`);
		$select.closest("li").append(legend);
		return legend;
	}

	window.QCAttrList = {
		install: install,
		// Exposed for the verification harness: what the list would be called,
		// without having to read colours back off the DOM.
		classify: (names) => names.map((name) => ({
			name: name,
			kind: VIEWER_MODES.has(name) ? "viewer" : "data",
		})),
		colourable: COLOURABLE,
		// Degrees per stored unit, keyed by attribute name. The scan angle tool in
		// qc_tools.js reads it from here so the conversion lives in one place.
		angleUnits: ANGLE_UNITS,
	};
})();
