const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'code.js'), 'utf8');
const mixed = Symbol('figma.mixed');
const context = {
  __html__: '',
  console,
  figma: {
    mixed,
    showUI() {},
    base64Encode() {
      return 'BASE64_DATA';
    },
    currentPage: { selection: [] },
    ui: { postMessage() {} },
    on() {},
  },
};

vm.runInNewContext(
  `${source}
globalThis.__testApi = {
  extractCss,
  isFullEllipse,
  isVectorOnlySubtree,
  buildCompactNode,
  buildRawNode,
  borderInset,
  generateHtml,
  generateDartForNode,
  generateDart,
};`,
  context,
  { filename: 'code.js' }
);

const api = context.__testApi;
const solid = (r, g, b, opacity = 1) => ({
  type: 'SOLID',
  visible: true,
  color: { r, g, b },
  opacity,
});

async function run() {
  const selectedIndicator = {
    id: 'ellipse:selected',
    type: 'ELLIPSE',
    name: 'Indicator',
    width: 8,
    height: 8,
    opacity: 1,
    fills: [solid(0.352941, 0.364706, 0.423529)],
    strokes: [],
    effects: [],
    arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 },
    children: [],
  };

  assert.equal(api.isFullEllipse(selectedIndicator), true);
  assert.equal(api.extractCss(selectedIndicator).css['border-radius'], '50%');
  assert.equal(api.isVectorOnlySubtree(selectedIndicator), false);

  const ellipseHtml = await api.generateHtml(selectedIndicator);
  assert.match(ellipseHtml.html, /border-radius: 50%;/);
  assert.doesNotMatch(ellipseHtml.html, /background-image:/);

  const donut = {
    ...selectedIndicator,
    id: 'ellipse:donut',
    name: 'Progress Donut',
    arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0.5 },
  };
  assert.equal(api.isFullEllipse(donut), false);
  assert.equal(api.isVectorOnlySubtree(donut), true);

  const halfCircle = {
    ...selectedIndicator,
    id: 'ellipse:half',
    name: 'Half Circle',
    arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 },
  };
  assert.equal(api.isFullEllipse(halfCircle), false);
  assert.equal(api.isVectorOnlySubtree(halfCircle), true);

  const compact = api.buildCompactNode(selectedIndicator);
  assert.equal(compact.shape, 'ellipse');
  assert.equal(compact.borderRadius, '50%');

  const raw = api.buildRawNode(donut);
  assert.equal(raw.arcData.innerRadius, 0.5);
  assert.equal(raw.arcData.endingAngle, Math.PI * 2);

  const divider = {
    id: 'frame:divider',
    type: 'FRAME',
    name: 'Divider Row',
    width: 327,
    height: 106,
    opacity: 1,
    fills: [],
    strokes: [solid(0, 0, 0, 0.2)],
    strokeWeight: mixed,
    strokeAlign: 'INSIDE',
    strokeTopWeight: 0,
    strokeRightWeight: 0,
    strokeBottomWeight: 1,
    strokeLeftWeight: 0,
    effects: [],
    children: [],
  };
  const dividerCss = api.extractCss(divider).css;
  assert.equal(dividerCss['border-bottom'], '1px solid rgba(0, 0, 0, 0.2)');
  assert.equal(dividerCss.border, undefined);
  assert.deepEqual(
    { ...api.borderInset(divider) },
    { left: 0, top: 0 }
  );

  const headerShadow = {
    id: 'frame:transparent-header',
    type: 'FRAME',
    name: 'Header',
    width: 311,
    height: 32,
    opacity: 1,
    fills: [{ ...solid(1, 1, 1), visible: false }],
    strokes: [],
    effects: [
      {
        type: 'DROP_SHADOW',
        visible: true,
        radius: 1.57,
        spread: 0,
        offset: { x: 0, y: 1.57 },
        color: { r: 0, g: 0, b: 0, a: 0.25 },
      },
    ],
    children: [{ id: 'text:header', type: 'TEXT', name: 'Label', visible: true }],
  };
  const headerCss = api.extractCss(headerShadow).css;
  assert.equal(headerCss['box-shadow'], undefined);
  assert.equal(
    headerCss.filter,
    'drop-shadow(0px 1.57px 1.57px rgba(0, 0, 0, 0.25))'
  );

  const filledCard = {
    ...headerShadow,
    id: 'frame:filled-card',
    name: 'Card',
    fills: [solid(1, 1, 1)],
  };
  const cardCss = api.extractCss(filledCard).css;
  assert.equal(
    cardCss['box-shadow'],
    '0px 1.57px 1.57px 0px rgba(0, 0, 0, 0.25)'
  );
  assert.equal(cardCss.filter, undefined);

  const shadowAndBlur = {
    ...headerShadow,
    id: 'frame:shadow-and-blur',
    effects: [
      ...headerShadow.effects,
      { type: 'LAYER_BLUR', visible: true, radius: 2 },
    ],
  };
  assert.equal(
    api.extractCss(shadowAndBlur).css.filter,
    'drop-shadow(0px 1.57px 1.57px rgba(0, 0, 0, 0.25)) blur(2px)'
  );

  const gridCard = (id, row) => ({
    id,
    type: 'FRAME',
    name: `Guide Card ${row + 1}`,
    x: 0,
    y: row * 168,
    width: 350,
    height: 152,
    opacity: 1,
    visible: true,
    layoutPositioning: 'AUTO',
    layoutGrow: 1,
    gridColumnAnchorIndex: 0,
    gridRowAnchorIndex: row,
    gridColumnSpan: 1,
    gridRowSpan: 1,
    gridChildHorizontalAlign: 'STRETCH',
    gridChildVerticalAlign: 'STRETCH',
    fills: [solid(0.92, 0.93, 0.94)],
    strokes: [],
    effects: [],
    children: [],
  });
  const quickGuidesGrid = {
    id: 'frame:quick-guides-grid',
    type: 'FRAME',
    name: 'Quick Guides Grid',
    width: 350,
    height: 488,
    opacity: 1,
    visible: true,
    layoutMode: 'GRID',
    gridColumnCount: 1,
    gridRowCount: 3,
    gridColumnGap: 0,
    gridRowGap: 16,
    gridColumnSizes: [{ type: 'FIXED', value: 350 }],
    gridRowSizes: [
      { type: 'FIXED', value: 152 },
      { type: 'FIXED', value: 152 },
      { type: 'FIXED', value: 152 },
    ],
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    fills: [],
    strokes: [],
    effects: [],
    children: [gridCard('card:1', 0), gridCard('card:2', 1), gridCard('card:3', 2)],
  };
  const gridCss = api.extractCss(quickGuidesGrid).css;
  assert.equal(gridCss.display, 'grid');
  assert.equal(gridCss['grid-template-columns'], '350px');
  assert.equal(gridCss['grid-template-rows'], '152px 152px 152px');
  assert.equal(gridCss.gap, '16px 0px');

  const compactGrid = api.buildCompactNode(quickGuidesGrid);
  assert.equal(compactGrid.layout, 'grid');
  assert.equal(compactGrid.grid.columns, 1);
  assert.equal(compactGrid.grid.rowGap, 16);
  assert.equal(compactGrid.children[1].gridPosition.row, 1);

  const rawGrid = api.buildRawNode(quickGuidesGrid);
  assert.equal(rawGrid.gridColumnCount, 1);
  assert.equal(rawGrid.gridRowGap, 16);
  assert.equal(rawGrid.gridRowSizes[0].value, 152);

  const gridHtml = await api.generateHtml(quickGuidesGrid);
  assert.match(gridHtml.html, /grid-row: 2 \/ span 1;/);
  assert.match(gridHtml.html, /justify-self: stretch;/);
  assert.doesNotMatch(gridHtml.html, /flex-grow: 1;/);
  assert.equal(gridHtml.warnings.some((warning) => warning.includes('grid auto-layout is not supported')), false);

  const mixedTracks = {
    ...quickGuidesGrid,
    id: 'frame:mixed-grid',
    gridColumnCount: 3,
    gridColumnSizes: [
      { type: 'FIXED', value: 100 },
      { type: 'FLEX', value: 2 },
      { type: 'HUG' },
    ],
    gridColumnGap: 12,
  };
  assert.equal(
    api.extractCss(mixedTracks).css['grid-template-columns'],
    '100px 2fr max-content'
  );
  assert.equal(api.extractCss(mixedTracks).css.gap, '16px 12px');

  const oldFlexColumn = {
    ...quickGuidesGrid,
    id: 'frame:flex-regression',
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
  };
  const oldFlexCss = api.extractCss(oldFlexColumn).css;
  assert.equal(oldFlexCss.display, 'flex');
  assert.equal(oldFlexCss['flex-direction'], 'column');
  assert.equal(oldFlexCss.gap, '16px 0px');

  const italicText = {
    id: 'text:italic',
    type: 'TEXT',
    name: 'Italic Label',
    width: 100,
    height: 20,
    opacity: 1,
    characters: 'Italic',
    fontSize: 16,
    fontName: { family: 'Example Sans', style: 'SemiBold Italic' },
    fills: [solid(0, 0, 0)],
    strokes: [],
    effects: [],
  };
  const italicCss = api.extractCss(italicText).css;
  assert.equal(italicCss['font-weight'], '600');
  assert.equal(italicCss['font-style'], 'italic');

  const italicDart = api.generateDartForNode(italicText, 0, new Map());
  assert.match(italicDart, /fontFamily: 'Example Sans'/);
  assert.match(italicDart, /fontWeight: FontWeight\.w600/);
  assert.match(italicDart, /fontStyle: FontStyle\.italic/);

  const gridDart = api.generateDartForNode(quickGuidesGrid, 0, new Map());
  assert.match(gridDart, /Stack\(/);
  assert.match(gridDart, /clipBehavior: Clip\.none/);
  assert.match(gridDart, /top: 168/);
  assert.doesNotMatch(gridDart, /child: Column\(/);

  const dividerDart = api.generateDartForNode(divider, 0, new Map());
  assert.match(dividerDart, /border: Border\(/);
  assert.match(dividerDart, /bottom: BorderSide\(color: Color\(0x33000000\), width: 1/);
  assert.match(dividerDart, /top: BorderSide\.none/);

  const ellipseDart = api.generateDartForNode(selectedIndicator, 0, new Map());
  assert.match(ellipseDart, /BorderRadius\.all\(Radius\.elliptical\(4, 4\)\)/);

  const gradientNode = {
    id: 'frame:gradient',
    type: 'FRAME',
    name: 'Gradient',
    width: 100,
    height: 40,
    opacity: 1,
    fills: [
      {
        type: 'GRADIENT_LINEAR',
        visible: true,
        opacity: 1,
        gradientTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    ],
    strokes: [],
    effects: [],
    children: [],
  };
  assert.match(
    api.generateDartForNode(gradientNode, 0, new Map()),
    /gradient: LinearGradient\(/
  );

  const vectorAsset = {
    id: 'vector:asset',
    type: 'VECTOR',
    name: 'Icon',
    width: 24,
    height: 24,
    opacity: 1,
    visible: true,
    fills: [solid(1, 0, 0)],
    strokes: [],
    effects: [],
    children: [],
    async exportAsync() {
      return new Uint8Array([1, 2, 3]);
    },
  };
  const assetDart = await api.generateDart(vectorAsset);
  assert.match(assetDart, /import 'dart:convert';/);
  assert.match(assetDart, /Widget buildIcon\(\)/);
  assert.match(assetDart, /Image\.memory\(base64Decode\('BASE64_DATA'\)/);

  console.log('code regression tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
