# Contributing

Bug reports, ideas and pull requests are all welcome. This is a small fork with a
narrow purpose — checking the quality of a point cloud delivery — so the useful
thing to know before changing anything is where the traps are.

## Read this first

[`src/QC_TOOLS.md`](src/QC_TOOLS.md) is the real documentation. Two sections of it
matter more than the rest:

- **[Constraints worth keeping](src/QC_TOOLS.md#constraints-worth-keeping)** —
  changes that look like obvious improvements and each break something subtly.
  Every one of them cost hours to diagnose. The two that bite hardest:
  - never add anything to `pcoGeometry.pointAttributes`; it is the point *format*
    handed to the decoder worker, not a list of usable attributes
  - do not delete the VAO in `Renderer.deleteBuffer()`; `gl.deleteVertexArray`
    does not exist on this context and it freezes the viewer
- **[Potree patches](src/QC_TOOLS.md#potree-patches)** — four changes to the
  bundled `libs/potree/potree.js`, each marked with a `[QC Tools]` comment.
  **Re-apply them after any Potree upgrade**, or loading will wedge.

`main.js` and `src/desktop.js` also carry `[QC Tools]` comments on the few lines
that are not upstream. Grep for that marker before assuming a line is stock.

## Getting set up

```bash
npm install
npm start
```

Node.js and a Windows machine are the only requirements; PotreeConverter ships in
`libs/`. Drag a LAS/LAZ file onto the window to convert and load it.

## Layout

| File | What it is |
| --- | --- |
| `src/qc_tools.js` | The four viewer tools |
| `src/qc_fileinfo.js` | The file info report |
| `src/qc_tools.css` | Panel styling |
| `src/QC_TOOLS.md` | Documentation, constraints, and the measurements behind the design |
| `index.html` | Stylesheet, the two scripts, and `QCTools.install(viewer)` |
| `src/desktop.js`, `main.js` | Small additions marked `[QC Tools]` |
| `libs/potree/potree.js` | Four patches marked `[QC Tools]` |

Everything else is upstream PotreeDesktop. Keep changes to it minimal and marked,
so a future Potree upgrade is a merge rather than an excavation.

## How to verify a change

**There is no test suite**, and adding a conventional one to a WebGL viewer is a
poor trade. What has worked instead is a throwaway Electron script that drives the
real viewer headlessly and asserts on numbers:

- `_verify.js` in the repo root, run with
  `.\node_modules\.bin\electron.cmd _verify.js`
- point it at a converted cloud with an environment variable
- drive the tools through their public API (`QCTools.density.probeAt`,
  `QCTools.polygon.cutFromPoints`, `QCTools.densityColor.analyse`,
  `QCTools.fileInfo.report`)
- assert on renderer error count, `Potree.numNodesLoading`, deepest visible octree
  level, visible node and point count — **from an identical camera position before
  and after**, or the comparison means nothing
- delete the script when you are done; it is scaffolding, not a fixture

Four lessons from doing this, each paid for the hard way:

1. **Test clouds must exceed the point budget.** A 2.25M point cloud against a 3M
   budget never evicts or changes level of detail, so it cannot reproduce any
   rendering bug. Use a real sample.
2. **Always assert on renderer error count.** Several runs produced plausible
   numbers while throwing hundreds of errors in the background.
3. **For anything that computes a number, build a synthetic cloud with a known
   answer.** `laspy` is enough. The two that earned their keep are described in
   the [verification section](src/QC_TOOLS.md#verification): an L-shape, and an
   annulus with a hole and a detached block. The second one caught two separate
   coverage bugs that were invisible against real data.
4. **Look at the picture.** Both coverage bugs were obvious in a rasterised ASCII
   dump within seconds, and invisible in the numbers. For layout, screenshot the
   window with `webContents.capturePage()` rather than asserting only on text.

## Screenshots for the docs

The report window shows the **full path** of every file it read, so a screenshot
taken from a normal working directory publishes your home directory — and with it
your account name — into a public repository. It is easy to do without noticing.

Generate docs images from a throwaway path that carries no name, for example
`C:\qc_demo\...`, and check the image before committing it. Keep them small; the
report is mostly white, so a 1180 × 860 capture is around 250 KB.

## Style

Match the file you are editing. Tabs, and comments that say *why* rather than
*what* — the surprising constraint, the measurement that settled a choice, the
reason an obvious simplification does not work. Those are the comments that saved
time later; a comment restating the code is not.

## Upstream

The four `potree.js` fixes are upstream defects and would be worth offering to
[potree/PotreeDesktop](https://github.com/potree/PotreeDesktop) as a pull request
on their own. That has not been done yet.
