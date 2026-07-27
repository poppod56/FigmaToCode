figma.showUI(__html__, { width: 440, height: 620 });

function round(n) {
  return Math.round(n * 100) / 100;
}

function rgbToHex(color, opacity) {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = opacity === undefined ? 1 : opacity;
  if (a < 1) {
    return `rgba(${r}, ${g}, ${b}, ${round(a)})`;
  }
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mapFontWeight(style) {
  const s = (style || '').toLowerCase();
  if (s.includes('thin')) return 100;
  if (s.includes('extralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold')) return 600;
  if (s.includes('extrabold')) return 800;
  if (s.includes('bold')) return 700;
  if (s.includes('black') || s.includes('heavy')) return 900;
  return 400;
}

function mapFontStyle(style) {
  const s = (style || '').toLowerCase();
  if (s.includes('italic')) return 'italic';
  if (s.includes('oblique')) return 'oblique';
  return null;
}

// ---------- CSS extraction ----------

function averageGradientColor(fill) {
  const stops = fill.gradientStops || [];
  if (stops.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  stops.forEach((s) => {
    r += s.color.r;
    g += s.color.g;
    b += s.color.b;
    a += s.color.a !== undefined ? s.color.a : 1;
  });
  return { color: { r: r / stops.length, g: g / stops.length, b: b / stops.length }, opacity: a / stops.length };
}

// Figma expresses a linear gradient as a transform mapping the shape onto a
// unit gradient space that always runs along +x. Inverting it gives the axis
// back in shape space, which is what a CSS angle describes (0deg = up, then
// clockwise).
function gradientAngleDeg(gradientTransform) {
  if (!gradientTransform || !gradientTransform[0] || !gradientTransform[1]) return null;
  const a = gradientTransform[0][0];
  const b = gradientTransform[0][1];
  const c = gradientTransform[1][0];
  const d = gradientTransform[1][1];
  const det = a * d - b * c;
  if (!det) return null;
  const dx = d / det;
  const dy = -c / det;
  return round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
}

function gradientStopList(fill) {
  const layerOpacity = fill.opacity !== undefined ? fill.opacity : 1;
  return (fill.gradientStops || [])
    .map((s) => {
      const alpha = (s.color.a !== undefined ? s.color.a : 1) * layerOpacity;
      return `${rgbToHex(s.color, alpha)} ${round((s.position || 0) * 100)}%`;
    })
    .join(', ');
}

// One CSS background layer for a fill, preserving the real gradient instead of
// flattening it. Returns null for fills CSS can't express (image/pattern),
// which take the raster-export path instead.
function fillToBackgroundLayer(fill) {
  if (fill.type === 'SOLID') {
    // Expressed as a gradient so it can be stacked with other layers, which a
    // plain colour can't be.
    const c = rgbToHex(fill.color, fill.opacity !== undefined ? fill.opacity : 1);
    return `linear-gradient(${c}, ${c})`;
  }
  if (fill.type === 'GRADIENT_LINEAR') {
    const stops = gradientStopList(fill);
    if (!stops) return null;
    const angle = gradientAngleDeg(fill.gradientTransform);
    if (angle === null) return null;
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  if (fill.type === 'GRADIENT_RADIAL' || fill.type === 'GRADIENT_DIAMOND') {
    const stops = gradientStopList(fill);
    return stops ? `radial-gradient(${stops})` : null;
  }
  if (fill.type === 'GRADIENT_ANGULAR') {
    const stops = gradientStopList(fill);
    return stops ? `conic-gradient(${stops})` : null;
  }
  return null;
}

// Figma's blend modes map almost one-to-one onto CSS. The two Figma-only
// linear variants fall back to their nearest CSS relative; PASS_THROUGH and
// NORMAL mean "no blending" and deliberately have no entry.
const BLEND_MODE_CSS = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  LINEAR_BURN: 'color-burn',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  LINEAR_DODGE: 'color-dodge',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

// CSS has no linear-burn/linear-dodge, so these are the closest relatives
// rather than exact matches — worth telling the user about.
const APPROXIMATE_BLEND_MODES = ['LINEAR_BURN', 'LINEAR_DODGE'];

function blendModeWarning(node, mode) {
  return APPROXIMATE_BLEND_MODES.indexOf(mode) !== -1
    ? `"${node.name}": blend mode ${mode} has no exact CSS equivalent, approximated with ${BLEND_MODE_CSS[mode]}`
    : null;
}

// The blend mode a whole node composites with, if any.
function nodeBlendModeCss(node) {
  return BLEND_MODE_CSS[node.blendMode] || null;
}

// A node that is only a single fill blends with its backdrop exactly as that
// fill does, so a rasterized node can carry its fill's blend mode on itself.
function soleFillBlendModeCss(node) {
  if (!node.fills || node.fills === figma.mixed) return null;
  const visible = node.fills.filter((f) => f.visible !== false);
  if (visible.length !== 1) return null;
  return BLEND_MODE_CSS[visible[0].blendMode] || null;
}

// Builds the full `background` value from every visible fill. Figma paints
// fills bottom-to-top while CSS paints the first background layer on top, so
// the order is reversed. Returns null if any fill can't be expressed, letting
// the caller fall back to the flat approximation.
function fillsToBackgroundCss(node) {
  if (!node.fills || node.fills === figma.mixed) return null;
  const visible = node.fills.filter((f) => f.visible !== false);
  if (visible.length === 0) return null;
  const layers = [];
  const blends = [];
  for (let i = visible.length - 1; i >= 0; i--) {
    const layer = fillToBackgroundLayer(visible[i]);
    if (!layer) return null;
    layers.push(layer);
    blends.push(BLEND_MODE_CSS[visible[i].blendMode] || 'normal');
  }
  return {
    background: layers.join(', '),
    // Only worth emitting when at least one layer actually blends.
    blend: blends.some((b) => b !== 'normal') ? blends.join(', ') : null,
  };
}

function hasGradientFill(node) {
  if (!node.fills || node.fills === figma.mixed) return false;
  return node.fills.some((f) => f.visible !== false && f.type.indexOf('GRADIENT') === 0);
}

// Approximates a single fill layer as a flat {r,g,b,a}. Gradients collapse to
// their average stop color; image/unknown fills can't be approximated at all
// and are reported back as unsupported instead.
function flattenFillLayer(fill) {
  if (fill.type === 'SOLID') {
    return { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: fill.opacity !== undefined ? fill.opacity : 1 };
  }
  if (fill.type.indexOf('GRADIENT') === 0) {
    const avg = averageGradientColor(fill);
    if (!avg) return null;
    return {
      r: avg.color.r,
      g: avg.color.g,
      b: avg.color.b,
      a: avg.opacity * (fill.opacity !== undefined ? fill.opacity : 1),
    };
  }
  return null;
}

function getSolidFill(node) {
  if (!node.fills || node.fills === figma.mixed || node.fills.length === 0) return null;
  const visible = node.fills.filter((f) => f.visible !== false);
  if (visible.length === 0) return null;

  // Figma paints fills bottom-to-top, alpha-compositing each on top of the
  // last — replicate that instead of just picking one layer, since a partly
  // transparent top layer (a glossy highlight, say) is meant to tint what's
  // underneath, not replace it outright.
  let accR = 0;
  let accG = 0;
  let accB = 0;
  let accA = 0;
  let sawGradient = false;
  let sawImage = false;
  let sawUnknown = false;

  visible.forEach((fill) => {
    if (fill.type === 'IMAGE' || fill.type === 'PATTERN') {
      sawImage = true;
      return;
    }
    const layer = flattenFillLayer(fill);
    if (!layer) {
      sawUnknown = true;
      return;
    }
    if (fill.type.indexOf('GRADIENT') === 0) sawGradient = true;

    const outA = layer.a + accA * (1 - layer.a);
    if (outA > 0) {
      accR = (layer.r * layer.a + accR * accA * (1 - layer.a)) / outA;
      accG = (layer.g * layer.a + accG * accA * (1 - layer.a)) / outA;
      accB = (layer.b * layer.a + accB * accA * (1 - layer.a)) / outA;
    }
    accA = outA;
  });

  const notes = [];
  if (visible.length > 1) notes.push(`${visible.length} fills stacked, composited as a flat approximation`);
  if (sawGradient) notes.push('gradient fill(s) approximated as a flat average color');
  if (sawImage) notes.push('image/pattern fill has no CSS equivalent — the node is exported as a flattened image instead');
  if (sawUnknown) notes.push('unsupported fill type present, excluded from the approximation');
  const warning = notes.length ? `"${node.name}": ${notes.join('; ')}` : undefined;

  if (accA === 0) {
    return warning ? { warning } : null;
  }
  const result = { color: { r: accR, g: accG, b: accB }, opacity: accA };
  if (warning) result.warning = warning;
  return result;
}

function getStrokeData(node) {
  if (!node.strokes || node.strokes.length === 0) return null;
  const visible = node.strokes.filter((s) => s.visible !== false && s.type === 'SOLID');
  if (visible.length === 0) return null;
  const stroke = visible[0];
  const uniformWeight =
    node.strokeWeight !== undefined && node.strokeWeight !== figma.mixed ? node.strokeWeight : 1;
  // Rectangle/frame-like nodes expose the real weight of each edge. Prefer
  // these even when strokeWeight is currently numeric: older versions of the
  // Figma API could leave strokeWeight stale after individual edges changed.
  const sideWeight = (property) =>
    property in node && typeof node[property] === 'number' ? node[property] : uniformWeight;
  const weights = {
    top: sideWeight('strokeTopWeight'),
    right: sideWeight('strokeRightWeight'),
    bottom: sideWeight('strokeBottomWeight'),
    left: sideWeight('strokeLeftWeight'),
  };
  const style = node.dashPattern && node.dashPattern.length > 0 ? 'dashed' : 'solid';
  return {
    color: rgbToHex(stroke.color, stroke.opacity !== undefined ? stroke.opacity : 1),
    rawColor: stroke.color,
    rawOpacity: stroke.opacity !== undefined ? stroke.opacity : 1,
    style,
    weights,
    uniform:
      weights.top === weights.right &&
      weights.top === weights.bottom &&
      weights.top === weights.left,
  };
}

function applyStrokeCss(node, css, warnings) {
  const stroke = getStrokeData(node);
  if (!stroke) return;

  const value = (weight) => `${round(weight)}px ${stroke.style} ${stroke.color}`;
  if (stroke.uniform) {
    if (stroke.weights.top <= 0) return;
    // An outside-aligned uniform stroke can use outline without consuming any
    // of the node's Figma width/height.
    if (node.strokeAlign === 'OUTSIDE') css.outline = value(stroke.weights.top);
    else css.border = value(stroke.weights.top);
    return;
  }

  // CSS has first-class per-edge borders, which is the exact representation
  // for Figma's common INSIDE individual-stroke case (including dividers).
  ['top', 'right', 'bottom', 'left'].forEach((side) => {
    const weight = stroke.weights[side];
    if (weight > 0) css[`border-${side}`] = value(weight);
  });

  // CSS outline cannot vary by edge. Keeping the correct sides/weights is less
  // wrong than drawing a full outline, but it necessarily lands inside.
  if (node.strokeAlign === 'OUTSIDE') {
    warnings.push(
      `"${node.name}": individual OUTSIDE strokes have no exact CSS equivalent; sides and weights are preserved as inside borders`
    );
  }
}

function removeStrokeCss(css) {
  delete css.border;
  delete css['border-top'];
  delete css['border-right'];
  delete css['border-bottom'];
  delete css['border-left'];
  delete css.outline;
}

function getTextStrokeCss(node) {
  if (!node.strokes || node.strokes.length === 0) return null;
  const visible = node.strokes.filter((s) => s.visible !== false && s.type === 'SOLID');
  if (visible.length === 0) return null;
  const stroke = visible[0];
  const weight = node.strokeWeight !== undefined && node.strokeWeight !== figma.mixed ? node.strokeWeight : 1;
  return `${round(weight)}px ${rgbToHex(stroke.color, stroke.opacity !== undefined ? stroke.opacity : 1)}`;
}

function isFullEllipse(node) {
  if (node.type !== 'ELLIPSE') return false;
  if (!node.arcData) return true;
  const fullTurn = Math.PI * 2;
  const sweep = Math.abs(node.arcData.endingAngle - node.arcData.startingAngle);
  return Math.abs(sweep - fullTurn) < 0.0001 && Math.abs(node.arcData.innerRadius || 0) < 0.0001;
}

function getBorderRadiusCss(node) {
  // A Figma ELLIPSE has no cornerRadius property. A full ellipse maps exactly
  // to CSS border-radius: 50%, including non-square ovals. Partial arcs and
  // donuts take the SVG export path instead.
  if (isFullEllipse(node)) return '50%';
  if (node.cornerRadius === undefined) return null;
  // Per-corner radii: `cornerRadius` reads back as figma.mixed whenever the
  // four corners differ. Anything else non-numeric would produce `NaNpx`,
  // which silently invalidates the whole declaration.
  if (node.cornerRadius === figma.mixed || typeof node.cornerRadius !== 'number') {
    const tl = node.topLeftRadius || 0;
    const tr = node.topRightRadius || 0;
    const br = node.bottomRightRadius || 0;
    const bl = node.bottomLeftRadius || 0;
    return `${round(tl)}px ${round(tr)}px ${round(br)}px ${round(bl)}px`;
  }
  return `${round(node.cornerRadius)}px`;
}

function fillPaintIsVisible(fill) {
  if (!fill || fill.visible === false) return false;
  if (fill.opacity !== undefined && fill.opacity <= 0) return false;
  if (fill.type === 'SOLID') {
    return !fill.color || fill.color.a === undefined || fill.color.a > 0;
  }
  if (fill.type && fill.type.indexOf('GRADIENT') === 0) {
    return (fill.gradientStops || []).some((stop) => stop.color.a === undefined || stop.color.a > 0);
  }
  // Image, pattern and other paints are visually present when enabled.
  return true;
}

function hasVisibleFill(node) {
  if (!node.fills) return false;
  // Mixed fills cannot be inspected reliably; treating them as visible avoids
  // accidentally applying a child-alpha filter to a painted box.
  if (node.fills === figma.mixed) return true;
  return node.fills.some(fillPaintIsVisible);
}

function usesAlphaDropShadow(node) {
  const hasVisibleChildren = (node.children || []).some((child) => child.visible !== false);
  const hasDropShadow =
    node.effects &&
    node.effects.some((effect) => effect.type === 'DROP_SHADOW' && effect.visible !== false);
  return !hasVisibleFill(node) && hasVisibleChildren && !!hasDropShadow;
}

function getBoxShadowCss(node) {
  if (!node.effects || node.effects.length === 0) return null;
  const alphaDropShadow = usesAlphaDropShadow(node);
  const shadows = node.effects.filter(
    (e) =>
      (e.type === 'INNER_SHADOW' || (e.type === 'DROP_SHADOW' && !alphaDropShadow)) &&
      e.visible !== false
  );
  if (shadows.length === 0) return null;
  return shadows
    .map((s) => {
      const inset = s.type === 'INNER_SHADOW' ? 'inset ' : '';
      const color = rgbToHex(s.color, s.color.a !== undefined ? s.color.a : 1);
      const spread = s.spread ? `${round(s.spread)}px ` : '0px ';
      return `${inset}${round(s.offset.x)}px ${round(s.offset.y)}px ${round(s.radius)}px ${spread}${color}`;
    })
    .join(', ');
}

// A drop shadow on a transparent container in Figma follows the composited
// alpha of its children (text glyphs, icons, etc.). CSS box-shadow instead
// shadows the element's rectangular border box, producing a visible block
// behind headers. filter: drop-shadow() follows the rendered alpha correctly.
function getAlphaDropShadowFilterCss(node) {
  if (!usesAlphaDropShadow(node) || !node.effects || node.effects.length === 0) return null;
  const shadows = node.effects.filter((e) => e.type === 'DROP_SHADOW' && e.visible !== false);
  if (shadows.length === 0) return null;
  return shadows
    .map((s) => {
      const color = rgbToHex(s.color, s.color.a !== undefined ? s.color.a : 1);
      return `drop-shadow(${round(s.offset.x)}px ${round(s.offset.y)}px ${round(s.radius)}px ${color})`;
    })
    .join(' ');
}

function appendCssFilter(css, filter) {
  if (!filter) return;
  css.filter = css.filter ? `${css.filter} ${filter}` : filter;
}

// A shadow on a text node follows the glyph outlines. `box-shadow` would draw a
// rectangle behind the whole text box instead, which is where those stray dark
// blocks behind outlined headings came from.
function getTextShadowCss(node) {
  if (!node.effects || node.effects.length === 0) return null;
  const shadows = node.effects.filter((e) => e.type === 'DROP_SHADOW' && e.visible !== false);
  if (shadows.length === 0) return null;
  return shadows
    .map((s) => {
      const color = rgbToHex(s.color, s.color.a !== undefined ? s.color.a : 1);
      return `${round(s.offset.x)}px ${round(s.offset.y)}px ${round(s.radius)}px ${color}`;
    })
    .join(', ');
}

// Blur effects live on `filter`/`backdrop-filter`, not `box-shadow`.
function getBlurCss(node) {
  if (!node.effects || node.effects.length === 0) return null;
  let layerBlur = null;
  let backgroundBlur = null;
  node.effects.forEach((e) => {
    if (e.visible === false) return;
    if (e.type === 'LAYER_BLUR') layerBlur = e.radius;
    if (e.type === 'BACKGROUND_BLUR') backgroundBlur = e.radius;
  });
  if (layerBlur === null && backgroundBlur === null) return null;
  return {
    filter: layerBlur !== null ? `blur(${round(layerBlur)}px)` : null,
    backdropFilter: backgroundBlur !== null ? `blur(${round(backgroundBlur)}px)` : null,
  };
}

const PRIMARY_AXIS_ALIGN_CSS = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
};

const COUNTER_AXIS_ALIGN_CSS = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
};

const GRID_ITEM_ALIGN_CSS = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  STRETCH: 'stretch',
};

const TEXT_ALIGN_CSS = {
  LEFT: 'left',
  CENTER: 'center',
  RIGHT: 'right',
  JUSTIFIED: 'justify',
};

// TOP is CSS's natural behaviour, so it deliberately has no entry — only the
// cases that need extra rules are listed.
const TEXT_VALIGN_CSS = {
  CENTER: 'center',
  BOTTOM: 'flex-end',
};

const TEXT_ALIGN_FLUTTER = {
  LEFT: 'TextAlign.left',
  CENTER: 'TextAlign.center',
  RIGHT: 'TextAlign.right',
  JUSTIFIED: 'TextAlign.justify',
};

const PRIMARY_AXIS_ALIGN_FLUTTER = {
  MIN: 'MainAxisAlignment.start',
  CENTER: 'MainAxisAlignment.center',
  MAX: 'MainAxisAlignment.end',
  SPACE_BETWEEN: 'MainAxisAlignment.spaceBetween',
};

const COUNTER_AXIS_ALIGN_FLUTTER = {
  MIN: 'CrossAxisAlignment.start',
  CENTER: 'CrossAxisAlignment.center',
  MAX: 'CrossAxisAlignment.end',
  BASELINE: 'CrossAxisAlignment.baseline',
};

function getAutoLayoutCss(node) {
  if (!node.layoutMode || node.layoutMode === 'NONE') return null;
  if (node.layoutMode === 'GRID') {
    const trackToCss = (track) => {
      if (!track) return 'minmax(0, 1fr)';
      if (track.type === 'FIXED') return `${round(track.value || 0)}px`;
      if (track.type === 'HUG') return 'max-content';
      if (track.type === 'FLEX') return `${round(track.value || 1)}fr`;
      return 'minmax(0, 1fr)';
    };
    const columnCount = Math.max(1, node.gridColumnCount || 1);
    const rowCount = Math.max(1, node.gridRowCount || Math.ceil(((node.children || []).length || 1) / columnCount));
    const columns =
      node.gridColumnSizes && node.gridColumnSizes.length > 0
        ? node.gridColumnSizes.map(trackToCss).join(' ')
        : `repeat(${columnCount}, minmax(0, 1fr))`;
    const rows =
      node.gridRowSizes && node.gridRowSizes.length > 0
        ? node.gridRowSizes.map(trackToCss).join(' ')
        : `repeat(${rowCount}, minmax(0, 1fr))`;
    return {
      display: 'grid',
      'grid-template-columns': columns,
      'grid-template-rows': rows,
      gap: `${round(node.gridRowGap || 0)}px ${round(node.gridColumnGap || 0)}px`,
      padding: `${round(node.paddingTop || 0)}px ${round(node.paddingRight || 0)}px ${round(
        node.paddingBottom || 0
      )}px ${round(node.paddingLeft || 0)}px`,
    };
  }

  const css = {
    display: 'flex',
    'flex-direction': node.layoutMode === 'HORIZONTAL' ? 'row' : 'column',
  };
  const wraps = node.layoutWrap === 'WRAP';
  // Figma's wrapping auto-layout; without this the row runs off the edge
  // instead of flowing onto the next line.
  if (wraps) css['flex-wrap'] = 'wrap';

  // Figma keeps the last manual itemSpacing around even after you switch a
  // frame to "space between", but ignores it in that mode. CSS `gap` instead
  // stacks on top of the distributed space, pushing every item outward.
  const spaceBetween = node.primaryAxisAlignItems === 'SPACE_BETWEEN';
  const mainGap = spaceBetween || node.itemSpacing === undefined ? null : round(node.itemSpacing);
  const crossGap =
    wraps && node.counterAxisSpacing !== undefined && node.counterAxisSpacing !== null
      ? round(node.counterAxisSpacing)
      : null;

  if (mainGap !== null || crossGap !== null) {
    // `gap` is shorthand for `<row-gap> <column-gap>`, so both axes go in one
    // declaration — emitting `row-gap` separately would just be overwritten.
    const rowGap = node.layoutMode === 'HORIZONTAL' ? crossGap : mainGap;
    const colGap = node.layoutMode === 'HORIZONTAL' ? mainGap : crossGap;
    css.gap = `${round(rowGap || 0)}px ${round(colGap || 0)}px`;
  }
  const pt = node.paddingTop || 0;
  const pr = node.paddingRight || 0;
  const pb = node.paddingBottom || 0;
  const pl = node.paddingLeft || 0;
  css.padding = `${round(pt)}px ${round(pr)}px ${round(pb)}px ${round(pl)}px`;

  // Figma's "primary axis" is along flex-direction (justify-content in CSS);
  // its "counter axis" is across it (align-items). Without these, every
  // auto-layout frame defaults to start-aligned/stretched, which silently
  // breaks any design using center/end alignment — a very common setting.
  if (node.primaryAxisAlignItems && PRIMARY_AXIS_ALIGN_CSS[node.primaryAxisAlignItems]) {
    css['justify-content'] = PRIMARY_AXIS_ALIGN_CSS[node.primaryAxisAlignItems];
  }
  if (node.counterAxisAlignItems && COUNTER_AXIS_ALIGN_CSS[node.counterAxisAlignItems]) {
    css['align-items'] = COUNTER_AXIS_ALIGN_CSS[node.counterAxisAlignItems];
  }

  return css;
}

function getTextCss(node) {
  const css = {};
  if (node.fontName && node.fontName !== figma.mixed) {
    css['font-family'] = `"${node.fontName.family}"`;
    css['font-weight'] = String(mapFontWeight(node.fontName.style));
    const fontStyle = mapFontStyle(node.fontName.style);
    if (fontStyle) css['font-style'] = fontStyle;
  }
  if (node.fontSize !== undefined && node.fontSize !== figma.mixed) {
    css['font-size'] = `${round(node.fontSize)}px`;
  }
  if (node.letterSpacing && node.letterSpacing !== figma.mixed) {
    css['letter-spacing'] =
      node.letterSpacing.unit === 'PIXELS' ? `${round(node.letterSpacing.value)}px` : `${round(node.letterSpacing.value)}%`;
  }
  if (node.lineHeight && node.lineHeight !== figma.mixed) {
    if (node.lineHeight.unit === 'PIXELS') {
      css['line-height'] = `${round(node.lineHeight.value)}px`;
    } else if (node.lineHeight.unit === 'PERCENT') {
      css['line-height'] = `${round(node.lineHeight.value / 100)}`;
    } else {
      // "Auto" line height. Figma reports the box height as the height the
      // glyphs actually occupy, which for a hugging node is not the same as a
      // browser's `normal` line box — using `normal` leaves the ink sitting
      // several pixels lower than Figma draws it. Deriving the line height from
      // the box puts the ink back in the same place.
      // Only safe when the node hugs its text: then it can't wrap, so the line
      // count is just the explicit line breaks.
      const lines = node.textAutoResize === 'WIDTH_AND_HEIGHT' ? (node.characters || '').split('\n').length : 0;
      css['line-height'] = lines > 0 ? `${round(node.height / lines)}px` : 'normal';
    }
  }

  // Without this every text block falls back to the browser default (left),
  // so anything Figma centres or right-aligns lands in the wrong place inside
  // its own box even when the box itself is positioned correctly.
  // Figma only wraps text when the box has a fixed width. A hugging text node
  // is one line by definition, so letting CSS wrap it (fallback fonts measure
  // wider) breaks the layout. Explicit line breaks are preserved either way.
  css['white-space'] = node.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap';

  const hAlign = TEXT_ALIGN_CSS[node.textAlignHorizontal];
  if (hAlign) css['text-align'] = hAlign;

  // Figma anchors text vertically inside the text box; CSS has no direct
  // equivalent on a block, so centre/bottom need the box to become a flexbox.
  const vAlign = TEXT_VALIGN_CSS[node.textAlignVertical];
  if (vAlign) {
    css.display = 'flex';
    css['flex-direction'] = 'column';
    css['justify-content'] = vAlign;
  }

  return css;
}

function extractCss(node) {
  const css = {};
  const warnings = [];

  css.width = `${round(node.width)}px`;
  css.height = `${round(node.height)}px`;

  // CSS can reproduce stacked solid/gradient fills exactly, so prefer that and
  // only fall back to the flattened single colour when a fill has no CSS form.
  // A gradient-filled text node needs the background-clip trick rather than a
  // plain `color`, so it goes down the same path.
  const gradientText = node.type === 'TEXT' && hasGradientFill(node);
  const backgroundCss = node.type !== 'TEXT' || gradientText ? fillsToBackgroundCss(node) : null;

  const fill = getSolidFill(node);
  if (fill) {
    if (fill.warning && !backgroundCss) warnings.push(fill.warning);
    if (backgroundCss) {
      css.background = backgroundCss.background;
      if (backgroundCss.blend) css['background-blend-mode'] = backgroundCss.blend;
      if (gradientText) {
        // Paint the gradient through the glyphs instead of behind the box.
        css['-webkit-background-clip'] = 'text';
        css['background-clip'] = 'text';
        css.color = 'transparent';
      }
    } else if (fill.color) {
      // On a TEXT node, "fill" is the glyph color, not a background fill.
      if (node.type === 'TEXT') css.color = rgbToHex(fill.color, fill.opacity);
      else css.background = rgbToHex(fill.color, fill.opacity);
    }
  } else if (node.type === 'TEXT') {
    // Text with no visible fill is invisible in Figma, but CSS would inherit a
    // colour from an ancestor and draw it anyway.
    css.color = 'transparent';
  }

  if (node.type === 'TEXT') {
    // A stroke on a text node outlines the glyphs. Feeding it to `border` draws
    // a rectangle around the whole text box instead — the stray boxes around
    // outlined headings.
    const textStroke = getTextStrokeCss(node);
    if (textStroke) {
      css['-webkit-text-stroke'] = textStroke;
      // Figma's outside-aligned text stroke sits behind the glyph fill.
      css['paint-order'] = 'stroke fill';
    }
  } else {
    applyStrokeCss(node, css, warnings);
  }

  const radius = getBorderRadiusCss(node);
  if (radius) css['border-radius'] = radius;

  if (node.type === 'TEXT') {
    const textShadow = getTextShadowCss(node);
    if (textShadow) css['text-shadow'] = textShadow;
  } else {
    const shadow = getBoxShadowCss(node);
    if (shadow) css['box-shadow'] = shadow;
    appendCssFilter(css, getAlphaDropShadowFilterCss(node));
  }

  const blur = getBlurCss(node);
  if (blur) {
    appendCssFilter(css, blur.filter);
    if (blur.backdropFilter) css['backdrop-filter'] = blur.backdropFilter;
  }

  const autoLayout = getAutoLayoutCss(node);
  if (autoLayout) Object.assign(css, autoLayout);

  // Features that would otherwise fail quietly on files that use them — better
  // to say so than to emit confidently wrong output.
  if (node.fills === figma.mixed) {
    warnings.push(`"${node.name}": mixed fills across the node (per-character text colours?) — no fill applied`);
  }
  if (node.type === 'TEXT' && (node.fontName === figma.mixed || node.fontSize === figma.mixed)) {
    warnings.push(`"${node.name}": mixed fonts/sizes within one text node — only a single style is emitted`);
  }
  if (node.isMask) {
    warnings.push(`"${node.name}": mask layers are not supported, this renders as a normal shape instead of clipping its siblings`);
  }

  if (node.clipsContent) css.overflow = 'hidden';

  // How the node composites against what's behind it. Ignoring this is why a
  // white texture set to MULTIPLY (invisible in Figma) washed everything out.
  const blend = nodeBlendModeCss(node);
  if (blend) {
    css['mix-blend-mode'] = blend;
    const blendWarn = blendModeWarning(node, node.blendMode);
    if (blendWarn) warnings.push(blendWarn);
  }

  // Whole-node opacity (a layer's own opacity slider) is a separate thing
  // from fill opacity — a fully-opaque red fill on a node at 50% opacity
  // still needs to render at 50%.
  if (node.opacity !== undefined && node.opacity < 1) {
    css.opacity = `${round(node.opacity)}`;
  }

  // Figma rotation is in degrees, counter-clockwise for positive values;
  // CSS rotate() is clockwise for positive values, hence the sign flip.
  if (node.rotation) {
    css.transform = `rotate(${round(-node.rotation)}deg)`;
    // Figma's transform matrix rotates about the node's own top-left origin,
    // and x/y is where that corner lands. CSS defaults to rotating about the
    // center, which would shift the node off its recorded position.
    css['transform-origin'] = '0 0';
  }

  if (node.type === 'TEXT') {
    Object.assign(css, getTextCss(node));
  }

  return { css, warnings };
}

// ---------- Dart / Flutter generation ----------

function sanitizeVarName(name) {
  const cleaned = (name || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0) return 'widget';
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

function colorToDart(color, opacity) {
  const a = Math.round((opacity === undefined ? 1 : opacity) * 255);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return `Color(0x${hex(a)}${hex(r)}${hex(g)}${hex(b)})`;
}

function getSolidFillDart(node) {
  const fill = getSolidFill(node);
  if (!fill || !fill.color) return null;
  return colorToDart(fill.color, fill.opacity);
}

function paintColorToDart(color, opacity) {
  const alpha = (color.a !== undefined ? color.a : 1) * (opacity !== undefined ? opacity : 1);
  return colorToDart(color, alpha);
}

function getDartGradient(node) {
  if (!node.fills || node.fills === figma.mixed) return null;
  const visible = node.fills.filter((fill) => fill.visible !== false);
  if (visible.length !== 1 || visible[0].type.indexOf('GRADIENT') !== 0) return null;
  const fill = visible[0];
  const stops = fill.gradientStops || [];
  if (stops.length === 0) return null;
  const colors = stops.map((stop) => paintColorToDart(stop.color, fill.opacity)).join(', ');
  const positions = stops.map((stop) => round(stop.position || 0)).join(', ');
  if (fill.type === 'GRADIENT_LINEAR') {
    const cssAngle = gradientAngleDeg(fill.gradientTransform);
    const radians = cssAngle === null ? 0 : round(((cssAngle - 90) * Math.PI) / 180);
    return `LinearGradient(colors: const [${colors}], stops: const [${positions}], transform: GradientRotation(${radians}))`;
  }
  if (fill.type === 'GRADIENT_ANGULAR') {
    return `SweepGradient(colors: const [${colors}], stops: const [${positions}])`;
  }
  return `RadialGradient(colors: const [${colors}], stops: const [${positions}])`;
}

function dartBorderSide(stroke, weight) {
  if (weight <= 0) return 'BorderSide.none';
  const alignMap = {
    INSIDE: 'BorderSide.strokeAlignInside',
    OUTSIDE: 'BorderSide.strokeAlignOutside',
    CENTER: 'BorderSide.strokeAlignCenter',
  };
  const strokeAlign = alignMap[stroke.align] || 'BorderSide.strokeAlignInside';
  return `BorderSide(color: ${stroke.color}, width: ${round(weight)}, strokeAlign: ${strokeAlign})`;
}

function getDartBorder(node) {
  const data = getStrokeData(node);
  if (!data) return null;
  const stroke = {
    color: colorToDart(
      data.rawColor || { r: 0, g: 0, b: 0 },
      data.rawOpacity !== undefined ? data.rawOpacity : 1
    ),
    align: node.strokeAlign,
  };
  if (data.uniform) {
    if (data.weights.top <= 0) return null;
    return `Border.fromBorderSide(${dartBorderSide(stroke, data.weights.top)})`;
  }
  return `Border(top: ${dartBorderSide(stroke, data.weights.top)}, right: ${dartBorderSide(
    stroke,
    data.weights.right
  )}, bottom: ${dartBorderSide(stroke, data.weights.bottom)}, left: ${dartBorderSide(
    stroke,
    data.weights.left
  )})`;
}

function getDartBoxShadows(node) {
  if (!hasVisibleFill(node) || !node.effects) return null;
  const shadows = node.effects.filter((effect) => effect.type === 'DROP_SHADOW' && effect.visible !== false);
  if (shadows.length === 0) return null;
  return `[${shadows
    .map(
      (shadow) =>
        `BoxShadow(color: ${paintColorToDart(shadow.color, 1)}, offset: Offset(${round(
          shadow.offset.x
        )}, ${round(shadow.offset.y)}), blurRadius: ${round(shadow.radius)}, spreadRadius: ${round(
          shadow.spread || 0
        )})`
    )
    .join(', ')}]`;
}

function getDartBorderRadius(node) {
  if (isFullEllipse(node)) {
    return `BorderRadius.all(Radius.elliptical(${round(node.width / 2)}, ${round(node.height / 2)}))`;
  }
  if (node.cornerRadius === undefined) return null;
  if (node.cornerRadius === figma.mixed || typeof node.cornerRadius !== 'number') {
    return `BorderRadius.only(topLeft: Radius.circular(${round(
      node.topLeftRadius || 0
    )}), topRight: Radius.circular(${round(node.topRightRadius || 0)}), bottomRight: Radius.circular(${round(
      node.bottomRightRadius || 0
    )}), bottomLeft: Radius.circular(${round(node.bottomLeftRadius || 0)}))`;
  }
  return node.cornerRadius > 0 ? `BorderRadius.circular(${round(node.cornerRadius)})` : null;
}

function generateDartTextWidget(node, pad) {
  const style = [];
  if (node.fontSize !== undefined && node.fontSize !== figma.mixed) style.push(`fontSize: ${round(node.fontSize)}`);
  if (node.fontName && node.fontName !== figma.mixed) {
    style.push(`fontFamily: '${node.fontName.family.replace(/'/g, "\\'")}'`);
    style.push(`fontWeight: FontWeight.w${mapFontWeight(node.fontName.style)}`);
    if (mapFontStyle(node.fontName.style)) style.push('fontStyle: FontStyle.italic');
  }
  const color = getSolidFillDart(node);
  if (color) style.push(`color: ${color}`);
  if (node.letterSpacing && node.letterSpacing !== figma.mixed && node.letterSpacing.value) {
    const spacing =
      node.letterSpacing.unit === 'PERCENT' && typeof node.fontSize === 'number'
        ? (node.fontSize * node.letterSpacing.value) / 100
        : node.letterSpacing.value;
    style.push(`letterSpacing: ${round(spacing)}`);
  }
  if (node.lineHeight && node.lineHeight !== figma.mixed && typeof node.fontSize === 'number') {
    if (node.lineHeight.unit === 'PIXELS') style.push(`height: ${round(node.lineHeight.value / node.fontSize)}`);
    if (node.lineHeight.unit === 'PERCENT') style.push(`height: ${round(node.lineHeight.value / 100)}`);
  }
  if (node.effects) {
    const shadows = node.effects.filter((effect) => effect.type === 'DROP_SHADOW' && effect.visible !== false);
    if (shadows.length > 0) {
      style.push(
        `shadows: [${shadows
          .map(
            (shadow) =>
              `Shadow(color: ${paintColorToDart(shadow.color, 1)}, offset: Offset(${round(
                shadow.offset.x
              )}, ${round(shadow.offset.y)}), blurRadius: ${round(shadow.radius)})`
          )
          .join(', ')}]`
      );
    }
  }
  const text = (node.characters || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const align = TEXT_ALIGN_FLUTTER[node.textAlignHorizontal];
  const alignArg = align ? `\n${pad}  textAlign: ${align},` : '';
  return `Text(\n${pad}  '${text}',${alignArg}\n${pad}  style: TextStyle(${style.join(', ')}),\n${pad})`;
}

async function collectFlutterAssets(node, assets) {
  if (!isRenderable(node)) return;
  const rotatedContainer = !!node.rotation && node.children && node.children.filter(isRenderable).length > 0;
  const styledTextNeedsRaster =
    node.type === 'TEXT' &&
    ((node.strokes && node.strokes.some((stroke) => stroke.visible !== false)) ||
      hasGradientFill(node) ||
      node.fontName === figma.mixed ||
      node.fontSize === figma.mixed);
  if (
    isVectorOnlySubtree(node) ||
    needsRasterFill(node) ||
    rotatedContainer ||
    usesAlphaDropShadow(node) ||
    styledTextNeedsRaster
  ) {
    try {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      assets.set(node.id, figma.base64Encode(bytes));
      return;
    } catch (e) {
      // Fall through to editable widgets when an asset cannot be exported.
    }
  }
  for (const child of node.children || []) {
    await collectFlutterAssets(child, assets);
  }
}

function generateDartForNode(node, indent, assets) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  const name = sanitizeVarName(node.name);
  const asset = assets && assets.get(node.id);

  let inner;
  const visibleChildren = (node.children || []).filter(isRenderable);

  if (asset) {
    inner = `Image.memory(base64Decode('${asset}'), width: ${round(node.width)}, height: ${round(
      node.height
    )}, fit: BoxFit.fill, gaplessPlayback: true)`;
  } else if (node.type === 'TEXT') {
    inner = generateDartTextWidget(node, pad);
  } else if (visibleChildren.length > 0) {
    const isAutoLayout = !!(node.layoutMode && node.layoutMode !== 'NONE');

    if (node.layoutMode === 'GRID') {
      // Flutter core has no CSS-grid equivalent for mixed FIXED/FLEX/HUG
      // tracks and arbitrary spans. Figma has already resolved the exact
      // geometry, so a non-clipping Stack preserves every grid variant without
      // requiring a third-party package.
      const parts = visibleChildren.map((child) => {
        const off = childOffsetWithin(node, child);
        return `${pad}    Positioned(\n${pad}      left: ${round(off.left)},\n${pad}      top: ${round(
          off.top
        )},\n${pad}      child: ${generateDartForNode(child, indent + 3, assets)},\n${pad}    )`;
      });
      inner = `Stack(\n${pad}  clipBehavior: Clip.none,\n${pad}  children: [\n${parts.join(',\n')},\n${pad}  ],\n${pad})`;
    } else if (!isAutoLayout) {
      // Non-auto-layout Figma frames position children freely by x/y — a bare
      // Stack() would collapse them all to the top-left, so pin each one with
      // Positioned to match its real offset.
      const parts = visibleChildren.map((child) => {
        const off = childOffsetWithin(node, child);
        return `${pad}    Positioned(\n${pad}      left: ${round(off.left)},\n${pad}      top: ${round(off.top)},\n${pad}      child: ${generateDartForNode(
          child,
          indent + 3,
          assets
        )},\n${pad}    )`;
      });
      inner = `Stack(\n${pad}  children: [\n${parts.join(',\n')},\n${pad}  ],\n${pad})`;
    } else {
      // Even inside an auto-layout frame, an individual child can be flagged
      // "Absolute position" in Figma to detach it from the flex flow and
      // float freely — overlays/badges rely on this constantly. Those need
      // Positioned inside an outer Stack; the rest flow through Row/Column as usual.
      const flowChildren = visibleChildren.filter((c) => c.layoutPositioning !== 'ABSOLUTE');
      const overlayChildren = visibleChildren.filter((c) => c.layoutPositioning === 'ABSOLUTE');

      const widgetType = node.layoutMode === 'HORIZONTAL' ? 'Row' : 'Column';
      // Same as the CSS side: Figma ignores itemSpacing under "space between",
      // and MainAxisAlignment.spaceBetween already distributes the slack.
      const gap = node.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 0 : node.itemSpacing || 0;
      const parts = [];
      flowChildren.forEach((child, i) => {
        if (i > 0 && gap > 0) {
          const sizeProp = node.layoutMode === 'HORIZONTAL' ? 'width' : 'height';
          parts.push(`${pad}    SizedBox(${sizeProp}: ${round(gap)})`);
        }
        parts.push(`${pad}    ${generateDartForNode(child, indent + 2, assets)}`);
      });
      const alignmentProps = [];
      if (node.primaryAxisAlignItems && PRIMARY_AXIS_ALIGN_FLUTTER[node.primaryAxisAlignItems]) {
        alignmentProps.push(`mainAxisAlignment: ${PRIMARY_AXIS_ALIGN_FLUTTER[node.primaryAxisAlignItems]}`);
      }
      if (node.counterAxisAlignItems && COUNTER_AXIS_ALIGN_FLUTTER[node.counterAxisAlignItems]) {
        alignmentProps.push(`crossAxisAlignment: ${COUNTER_AXIS_ALIGN_FLUTTER[node.counterAxisAlignItems]}`);
      }
      const alignmentCode = alignmentProps.length > 0 ? `\n${pad}  ${alignmentProps.join(`,\n${pad}  `)},` : '';
      const flowWidget = `${widgetType}(${alignmentCode}\n${pad}  children: [\n${parts.join(',\n')},\n${pad}  ],\n${pad})`;

      if (overlayChildren.length > 0) {
        const overlayParts = overlayChildren.map((child) => {
          const off = childOffsetWithin(node, child);
          return `${pad}    Positioned(\n${pad}      left: ${round(off.left)},\n${pad}      top: ${round(
            off.top
          )},\n${pad}      child: ${generateDartForNode(child, indent + 3, assets)},\n${pad}    )`;
        });
        inner = `Stack(\n${pad}  children: [\n${pad}    ${flowWidget},\n${overlayParts.join(',\n')},\n${pad}  ],\n${pad})`;
      } else {
        inner = flowWidget;
      }
    }
  } else {
    inner = 'const SizedBox()';
  }

  const decoParts = [];
  if (node.type !== 'TEXT' && !asset) {
    const color = getSolidFillDart(node);
    const gradient = getDartGradient(node);
    if (gradient) decoParts.push(`gradient: ${gradient}`);
    else if (color) decoParts.push(`color: ${color}`);
    const border = getDartBorder(node);
    if (border) decoParts.push(`border: ${border}`);
    const shadows = getDartBoxShadows(node);
    if (shadows) decoParts.push(`boxShadow: ${shadows}`);
  }
  const borderRadius = !asset ? getDartBorderRadius(node) : null;
  if (borderRadius) decoParts.push(`borderRadius: ${borderRadius}`);
  const decoCode = decoParts.length > 0 ? `\n${pad}  decoration: BoxDecoration(${decoParts.join(', ')}),` : '';

  let paddingCode = '';
  if (!asset && node.layoutMode && node.layoutMode !== 'NONE') {
    const pt = node.paddingTop || 0;
    const pr = node.paddingRight || 0;
    const pb = node.paddingBottom || 0;
    const pl = node.paddingLeft || 0;
    if (pt || pr || pb || pl) {
      paddingCode = `\n${pad}  padding: const EdgeInsets.fromLTRB(${round(pl)}, ${round(pt)}, ${round(pr)}, ${round(pb)}),`;
    }
  }

  let widget =
    `// ${name}\n` +
    `${pad}Container(\n` +
    `${pad}  width: ${round(node.width)},\n` +
    `${pad}  height: ${round(node.height)},${decoCode}${paddingCode}\n` +
    `${pad}  child: ${inner},\n` +
    `${pad})`;

  // Figma rotation is in degrees, counter-clockwise for positive values;
  // Transform.rotate takes radians clockwise, hence the sign flip + conversion.
  if (node.rotation) {
    const radians = round((-node.rotation * Math.PI) / 180);
    widget = `Transform.rotate(\n${pad}  angle: ${radians},\n${pad}  alignment: Alignment.topLeft,\n${pad}  child: ${widget},\n${pad})`;
  }
  if (node.opacity !== undefined && node.opacity < 1) {
    widget = `Opacity(\n${pad}  opacity: ${round(node.opacity)},\n${pad}  child: ${widget},\n${pad})`;
  }

  return widget;
}

async function generateDart(node) {
  const assets = new Map();
  await collectFlutterAssets(node, assets);
  const imports = [`import 'package:flutter/material.dart';`];
  if (assets.size > 0) imports.unshift(`import 'dart:convert';`);
  const baseName = sanitizeVarName(node.name);
  const functionName = `build${baseName.charAt(0).toUpperCase()}${baseName.slice(1)}`;
  return `${imports.join('\n')}\n\nWidget ${functionName}() {\n  return ${generateDartForNode(
    node,
    1,
    assets
  )};\n}`;
}

// ---------- Full-tree HTML/CSS generation ----------

function toClassName(name, type, usedNames) {
  let base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  // Names with no ASCII letters/digits left (e.g. CJK/Thai-only layer names)
  // sanitize down to '' — fall back to the node type instead of a bare number.
  if (!base) base = (type || 'node').toLowerCase();
  // CSS class selectors can't start with a digit (e.g. a layer literally named "1").
  if (/^[0-9]/.test(base)) base = `n-${base}`;

  let className = base;
  let i = 2;
  while (usedNames.has(className)) {
    className = `${base}-${i}`;
    i++;
  }
  usedNames.add(className);
  return className;
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Node types with no direct CSS equivalent — arbitrary vector paths. A node of
// one of these types (or a group made up entirely of them) can't be represented
// as a styled <div>, so it gets flattened into a single exported SVG instead.
const VECTOR_ONLY_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'POLYGON'];

// Hand-deriving a child's position from x/y is fragile: groups don't establish
// their own coordinate space (a group's children carry x/y in its parent
// frame's space), and rotation happens about a node's own center, not its x/y
// corner — getting either wrong throws descendants off by exactly one
// width/height, which is exactly what happened here before. Figma has already
// resolved all of that into `absoluteBoundingBox` (page-space, rotation-aware,
// group-transparency-aware), so diffing two of those is the one calculation
// that can't get the coordinate space wrong.
function childOffsetWithin(parent, child) {
  const pBox = parent.absoluteBoundingBox;
  const cBox = child.absoluteBoundingBox;
  if (pBox && cBox) {
    return { left: cBox.x - pBox.x, top: cBox.y - pBox.y };
  }
  // Fallback for the rare node without a bounding box (shouldn't normally happen).
  return { left: child.x, top: child.y };
}

// The rotated axis-aligned size of a node, straight from Figma's own geometry
// rather than re-deriving it with trigonometry.
function renderedSize(node) {
  const box = node.absoluteBoundingBox;
  return box ? { width: box.width, height: box.height } : { width: node.width, height: node.height };
}

// Width of the border we emit for a node, which CSS counts inside the padding
// box — absolutely positioned children anchor to the padding box, so their
// offsets have to be pulled back by it to land where Figma puts them.
function borderInset(node) {
  const stroke = getStrokeData(node);
  if (!stroke) return { left: 0, top: 0 };
  if (node.strokeAlign && node.strokeAlign !== 'INSIDE' && node.strokeAlign !== 'CENTER') {
    return { left: 0, top: 0 };
  }
  return { left: stroke.weights.left, top: stroke.weights.top };
}

function isVectorOnlySubtree(node) {
  // Full ellipses have an exact, editable CSS representation. Arc/pie/donut
  // variants do not, so keep those pixel-exact by exporting them as SVG.
  if (node.type === 'ELLIPSE' && !isFullEllipse(node)) return true;
  if (VECTOR_ONLY_TYPES.indexOf(node.type) !== -1) return true;
  if (!node.children || node.children.length === 0) return false;
  return node.children.every(isVectorOnlySubtree);
}

// Fill types with no CSS equivalent at all: a bitmap, or Figma's PATTERN fill
// (a tiled source node). Approximating these with a flat colour is worse than
// nothing — the flat colour paints over whatever sits behind the node — so
// these get rasterized into a real image instead.
function needsRasterFill(node) {
  if (!node.fills || node.fills === figma.mixed) return false;
  return node.fills.some((f) => f.visible !== false && (f.type === 'IMAGE' || f.type === 'PATTERN'));
}

// Walks the tree once, exporting anything that needs a real rasterized/vector
// asset (icons made of vector paths, image fills) and stashing it as a data:
// URI keyed by node id, so the whole HTML file stays self-contained — no
// separate asset files to manage.
// Layers toggled off with the eye icon in Figma still come through the API —
// rendering them anyway both draws hidden art and, inside auto-layout, steals
// flow space that shifts every sibling after them.
function isRenderable(node) {
  return node.visible !== false;
}

async function collectAssets(node, assets) {
  if (!isRenderable(node)) return;
  if (isVectorOnlySubtree(node)) {
    try {
      const bytes = await node.exportAsync({ format: 'SVG' });
      assets.set(node.id, `data:image/svg+xml;base64,${figma.base64Encode(bytes)}`);
    } catch (e) {
      // leave unexported — falls back to an empty box rather than failing the whole export
    }
    return;
  }
  // A rotated container is the one case CSS nesting genuinely can't express:
  // its children's coordinates are recorded in the *unrotated* parent space,
  // but nesting them inside a CSS-rotated element rotates them a second time.
  // Rasterizing the whole thing is pixel-exact where the math would be wrong.
  const rotatedContainer = !!node.rotation && node.children && node.children.filter(isRenderable).length > 0;

  if (needsRasterFill(node) || rotatedContainer) {
    try {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      assets.set(node.id, `data:image/png;base64,${figma.base64Encode(bytes)}`);
      if (rotatedContainer) return; // its children are baked into the image
    } catch (e) {
      // same fallback as above
    }
  }
  if (node.children) {
    for (const child of node.children) {
      await collectAssets(child, assets);
    }
  }
}

function generateHtmlTree(node, usedNames, rules, warnings, indent, assets, posOverride, flexChild, gridChild) {
  const pad = '  '.repeat(indent);
  const className = toClassName(node.name, node.type, usedNames);
  const { css, warnings: nodeWarnings } = extractCss(node);
  nodeWarnings.forEach((w) => warnings.push(w));

  // A non-auto-layout Figma frame positions children freely by x/y (can
  // overlap, float anywhere) — normal HTML block flow can't reproduce that,
  // so such children get pinned with position: absolute + the real offset.
  if (posOverride) {
    css.position = 'absolute';
    css.left = `${round(posOverride.left)}px`;
    css.top = `${round(posOverride.top)}px`;
  }

  if (flexChild) {
    // CSS flex items shrink below their stated size by default; Figma
    // auto-layout children never do unless explicitly set to fill. Without
    // this, every fixed-width child silently gets squeezed.
    css['flex-shrink'] = '0';
    if (node.layoutGrow === 1) css['flex-grow'] = '1';
    if (node.layoutAlign === 'STRETCH') css['align-self'] = 'stretch';
  }

  if (gridChild) {
    const columnStart =
      typeof node.gridColumnAnchorIndex === 'number' ? node.gridColumnAnchorIndex + 1 : null;
    const rowStart = typeof node.gridRowAnchorIndex === 'number' ? node.gridRowAnchorIndex + 1 : null;
    const columnSpan = typeof node.gridColumnSpan === 'number' ? Math.max(1, node.gridColumnSpan) : 1;
    const rowSpan = typeof node.gridRowSpan === 'number' ? Math.max(1, node.gridRowSpan) : 1;
    if (columnStart !== null) css['grid-column'] = `${columnStart} / span ${columnSpan}`;
    else if (columnSpan > 1) css['grid-column'] = `span ${columnSpan}`;
    if (rowStart !== null) css['grid-row'] = `${rowStart} / span ${rowSpan}`;
    else if (rowSpan > 1) css['grid-row'] = `span ${rowSpan}`;

    const horizontalAlign = GRID_ITEM_ALIGN_CSS[node.gridChildHorizontalAlign];
    const verticalAlign = GRID_ITEM_ALIGN_CSS[node.gridChildVerticalAlign];
    if (horizontalAlign) css['justify-self'] = horizontalAlign;
    if (verticalAlign) css['align-self'] = verticalAlign;
  }

  const asset = assets.get(node.id);
  if (asset) {
    if (node.rotation) {
      // Figma's export renders the node as it appears, rotation already baked
      // in, sized to its rotated bounding box. Keeping the CSS rotate here
      // would spin it a second time.
      delete css.transform;
      delete css['transform-origin'];
      const box = renderedSize(node);
      css.width = `${round(box.width)}px`;
      css.height = `${round(box.height)}px`;
    }
    // The export already draws the node's own stroke and fills; re-adding them
    // double-draws, and a border inflates a zero-height divider into a 2px box
    // that shifts everything after it.
    removeStrokeCss(css);
    delete css.background;
    delete css['background-blend-mode'];

    // A straight stroked line (a divider) is 0px tall/wide by definition — its
    // visible thickness comes entirely from the stroke. `background-size:
    // contain` has no area to fit into on a zero-size axis, so the whole
    // export silently fails to show at all. Give that axis the stroke's real
    // width instead of leaving it at 0.
    const strokeWeight =
      node.strokeWeight !== undefined && node.strokeWeight !== figma.mixed ? node.strokeWeight : 1;
    if (node.strokes && node.strokes.length > 0) {
      if (node.width === 0) css.width = `${round(strokeWeight)}px`;
      if (node.height === 0) css.height = `${round(strokeWeight)}px`;
    }
    css['background-image'] = `url("${asset}")`;
    css['background-size'] = 'contain';
    css['background-repeat'] = 'no-repeat';

    // The export can bake in the fill itself but not how that fill blends with
    // what sits behind the node — that only happens at composite time, so it
    // has to be carried over to the element.
    if (!css['mix-blend-mode']) {
      const fillBlend = soleFillBlendModeCss(node);
      if (fillBlend) css['mix-blend-mode'] = fillBlend;
    }

    if (node.children && node.children.filter(isRenderable).length > 0) {
      warnings.push(
        `"${node.name}": flattened into a single exported image, so its ${
          node.children.filter(isRenderable).length
        } child layer(s) are baked in rather than emitted as editable markup`
      );
    }
  }

  const isAutoLayout = !!(node.layoutMode && node.layoutMode !== 'NONE');
  const visibleChildren = (node.children || []).filter(isRenderable);
  const hasChildren = visibleChildren.length > 0;
  // Even inside an auto-layout frame, an individual child can be flagged
  // "Absolute position" in Figma (layoutPositioning: 'ABSOLUTE') to detach it
  // from the flex flow and float freely — overlays/badges/backgrounds on top
  // of otherwise-flowing siblings rely on this constantly.
  const anyChildNeedsAbsolute =
    hasChildren && visibleChildren.some((c) => !isAutoLayout || c.layoutPositioning === 'ABSOLUTE');
  if (anyChildNeedsAbsolute && !asset) {
    // Establishes the containing block its own absolutely-positioned children
    // anchor to. If posOverride already set position: absolute above, that
    // already serves the same purpose — don't clobber it.
    css.position = css.position || 'relative';
  }

  const body = Object.keys(css)
    .map((k) => `  ${k}: ${css[k]};`)
    .join('\n');
  rules.push(`.${className} {\n${body}\n}`);

  // Exported as a flattened image — don't also emit its (now-redundant) vector sub-paths.
  if (asset) {
    return `${pad}<div class="${className}"></div>`;
  }

  if (node.type === 'TEXT') {
    return `${pad}<p class="${className}">${escapeHtml(node.characters)}</p>`;
  }
  if (hasChildren) {
    const inset = borderInset(node);
    const childrenHtml = visibleChildren
      .map((c) => {
        const childNeedsAbsolute = !isAutoLayout || c.layoutPositioning === 'ABSOLUTE';
        let childOverride = null;
        if (childNeedsAbsolute) {
          // absoluteBoundingBox already reflects rotation, so this is the
          // final rendered position directly — no separate rotation math needed.
          childOverride = childOffsetWithin(node, c);
          childOverride.left -= inset.left;
          childOverride.top -= inset.top;
        }
        const childIsGridItem = !childNeedsAbsolute && node.layoutMode === 'GRID';
        return generateHtmlTree(
          c,
          usedNames,
          rules,
          warnings,
          indent + 1,
          assets,
          childOverride,
          !childNeedsAbsolute && !childIsGridItem,
          childIsGridItem
        );
      })
      .join('\n');
    return `${pad}<div class="${className}">\n${childrenHtml}\n${pad}</div>`;
  }
  return `${pad}<div class="${className}"></div>`;
}

async function generateHtml(node) {
  const assets = new Map();
  await collectAssets(node, assets);

  const usedNames = new Set();
  const rules = [];
  const warnings = [];
  const body = generateHtmlTree(node, usedNames, rules, warnings, 0, assets);

  // Figma sizes include the stroke (its default stroke align is inside), and
  // <p> carries a default margin. Scope the reset to the generated root so
  // pasting this into an existing page can't disturb anything around it.
  const rootClass = rules.length > 0 ? rules[0].slice(1, rules[0].indexOf(' ')) : null;
  const reset = rootClass
    ? `.${rootClass}, .${rootClass} * {\n  box-sizing: border-box;\n  margin: 0;\n}`
    : null;

  const allRules = reset ? [reset].concat(rules) : rules;
  return {
    html: `${body}\n\n<style>\n${allRules.join('\n\n')}\n</style>`,
    // Deduped: the same caveat usually repeats across many sibling nodes.
    warnings: warnings.filter((w, i) => warnings.indexOf(w) === i),
  };
}

// ---------- Compact JSON for AI ----------

function buildCompactNode(node) {
  const compact = {
    type: node.type,
    name: node.name,
    width: round(node.width),
    height: round(node.height),
  };

  const fill = getSolidFill(node);
  if (fill && fill.color) compact.fill = rgbToHex(fill.color, fill.opacity);

  const radius = getBorderRadiusCss(node);
  if (radius) compact.borderRadius = radius;

  if (node.type === 'ELLIPSE') {
    compact.shape = isFullEllipse(node) ? 'ellipse' : 'arc';
    if (node.arcData) {
      compact.arcData = {
        startingAngle: round(node.arcData.startingAngle),
        endingAngle: round(node.arcData.endingAngle),
        innerRadius: round(node.arcData.innerRadius),
      };
    }
  }

  const stroke = node.type !== 'TEXT' ? getStrokeData(node) : null;
  if (stroke) {
    compact.stroke = {
      color: stroke.color,
      style: stroke.style,
      align: node.strokeAlign,
      top: round(stroke.weights.top),
      right: round(stroke.weights.right),
      bottom: round(stroke.weights.bottom),
      left: round(stroke.weights.left),
    };
  }

  if (node.type === 'TEXT') {
    compact.text = node.characters;
    if (node.fontSize !== undefined && node.fontSize !== figma.mixed) compact.fontSize = round(node.fontSize);
    if (node.fontName && node.fontName !== figma.mixed) {
      compact.fontFamily = node.fontName.family;
      compact.fontWeight = mapFontWeight(node.fontName.style);
      const fontStyle = mapFontStyle(node.fontName.style);
      if (fontStyle) compact.fontStyle = fontStyle;
    }
  }

  if (node.layoutMode && node.layoutMode !== 'NONE') {
    if (node.layoutMode === 'GRID') {
      compact.layout = 'grid';
      compact.grid = {
        columns: node.gridColumnCount || 1,
        rows: node.gridRowCount || Math.ceil(((node.children || []).length || 1) / (node.gridColumnCount || 1)),
        columnGap: round(node.gridColumnGap || 0),
        rowGap: round(node.gridRowGap || 0),
        columnSizes: (node.gridColumnSizes || []).map((track) => ({ type: track.type, value: track.value })),
        rowSizes: (node.gridRowSizes || []).map((track) => ({ type: track.type, value: track.value })),
      };
    } else {
      compact.layout = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
      if (node.itemSpacing) compact.gap = round(node.itemSpacing);
    }
  }

  const visibleChildren = (node.children || []).filter(isRenderable);
  if (visibleChildren.length > 0) {
    const isAutoLayout = node.layoutMode && node.layoutMode !== 'NONE';
    compact.children = visibleChildren.map((child) => {
      const childCompact = buildCompactNode(child);
      // Non-auto-layout parents position children freely by x/y (can overlap).
      // Even inside an auto-layout parent, a child can be individually flagged
      // "Absolute position" in Figma to float free of the flex flow (overlays,
      // badges) — flag both cases explicitly so the model doesn't just stack
      // everything in normal flow.
      if (!isAutoLayout || child.layoutPositioning === 'ABSOLUTE') {
        const off = childOffsetWithin(node, child);
        childCompact.x = round(off.left);
        childCompact.y = round(off.top);
      } else if (node.layoutMode === 'GRID') {
        childCompact.gridPosition = {
          column: typeof child.gridColumnAnchorIndex === 'number' ? child.gridColumnAnchorIndex : null,
          row: typeof child.gridRowAnchorIndex === 'number' ? child.gridRowAnchorIndex : null,
          columnSpan: child.gridColumnSpan || 1,
          rowSpan: child.gridRowSpan || 1,
        };
      }
      return childCompact;
    });
  }

  return compact;
}

// ---------- Ground-truth preview (real Figma render of the selection) ----------

async function exportPreviewPng(node) {
  // Cap resolution on big frames so export stays fast and the data URI stays small.
  const scale = node.width > 800 || node.height > 800 ? 1 : 2;
  try {
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    const uri = `data:image/png;base64,${figma.base64Encode(bytes)}`;

    // The export covers the node's *render* bounds, so a drop shadow or an
    // overhanging stroke makes the image bigger than the node box. Handing the
    // UI the two rects lets it crop back to the node box, so the preview lines
    // up with the generated markup instead of being offset and scaled slightly
    // differently.
    const box = node.absoluteBoundingBox;
    const render = node.absoluteRenderBounds;
    let crop = null;
    if (box && render && render.width > 0 && render.height > 0) {
      crop = {
        scale: scale,
        offsetX: round((box.x - render.x) * scale),
        offsetY: round((box.y - render.y) * scale),
        imageWidth: round(render.width * scale),
        imageHeight: round(render.height * scale),
      };
    }
    return { uri, crop };
  } catch (e) {
    return null;
  }
}

// ---------- Selection sync ----------

// Dumps as much of the real figma.* node data as JSON allows — every raw fill/
// stroke/effect/layout property, not just what CSS/Dart/HTML happen to need.
// This is what the "Send to Claude (debug)" button ships, so debugging a
// mismatch doesn't depend on guessing which property to ask the user to check.
function safeMixed(value) {
  return value === figma.mixed ? 'MIXED' : value;
}

function buildRawNode(node) {
  const raw = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    locked: node.locked,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    opacity: node.opacity,
    blendMode: node.blendMode,
    absoluteBoundingBox: node.absoluteBoundingBox,
  };

  if ('layoutMode' in node) raw.layoutMode = node.layoutMode;
  if ('layoutPositioning' in node) raw.layoutPositioning = node.layoutPositioning;
  if ('layoutGrow' in node) raw.layoutGrow = node.layoutGrow;
  if ('layoutWrap' in node) raw.layoutWrap = node.layoutWrap;
  if ('counterAxisSpacing' in node) raw.counterAxisSpacing = node.counterAxisSpacing;
  if ('isMask' in node) raw.isMask = node.isMask;
  if ('dashPattern' in node) raw.dashPattern = node.dashPattern;
  if ('layoutAlign' in node) raw.layoutAlign = node.layoutAlign;
  if ('layoutSizingHorizontal' in node) raw.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if ('layoutSizingVertical' in node) raw.layoutSizingVertical = node.layoutSizingVertical;
  if (node.layoutMode === 'GRID') {
    raw.gridColumnCount = node.gridColumnCount;
    raw.gridRowCount = node.gridRowCount;
    raw.gridColumnGap = node.gridColumnGap;
    raw.gridRowGap = node.gridRowGap;
    raw.gridColumnSizes = node.gridColumnSizes.map((track) => ({ type: track.type, value: track.value }));
    raw.gridRowSizes = node.gridRowSizes.map((track) => ({ type: track.type, value: track.value }));
    raw.gridAutoTracks = node.gridAutoTracks;
    raw.gridItemsPositioning = node.gridItemsPositioning;
  }
  if ('gridColumnAnchorIndex' in node) raw.gridColumnAnchorIndex = node.gridColumnAnchorIndex;
  if ('gridRowAnchorIndex' in node) raw.gridRowAnchorIndex = node.gridRowAnchorIndex;
  if ('gridColumnSpan' in node) raw.gridColumnSpan = node.gridColumnSpan;
  if ('gridRowSpan' in node) raw.gridRowSpan = node.gridRowSpan;
  if ('gridChildHorizontalAlign' in node) raw.gridChildHorizontalAlign = node.gridChildHorizontalAlign;
  if ('gridChildVerticalAlign' in node) raw.gridChildVerticalAlign = node.gridChildVerticalAlign;
  if ('textAutoResize' in node) raw.textAutoResize = node.textAutoResize;
  if ('itemSpacing' in node) raw.itemSpacing = node.itemSpacing;
  if ('paddingLeft' in node) {
    raw.padding = { left: node.paddingLeft, right: node.paddingRight, top: node.paddingTop, bottom: node.paddingBottom };
  }
  if ('primaryAxisAlignItems' in node) raw.primaryAxisAlignItems = node.primaryAxisAlignItems;
  if ('counterAxisAlignItems' in node) raw.counterAxisAlignItems = node.counterAxisAlignItems;
  if ('clipsContent' in node) raw.clipsContent = node.clipsContent;
  if ('cornerRadius' in node) raw.cornerRadius = safeMixed(node.cornerRadius);
  if ('arcData' in node) {
    raw.arcData = {
      startingAngle: node.arcData.startingAngle,
      endingAngle: node.arcData.endingAngle,
      innerRadius: node.arcData.innerRadius,
    };
  }

  if (node.fills && node.fills !== figma.mixed) {
    raw.fills = node.fills.map((f) => ({
      type: f.type,
      visible: f.visible,
      opacity: f.opacity,
      blendMode: f.blendMode,
      color: f.color,
      gradientStops: f.gradientStops,
      gradientTransform: f.gradientTransform,
    }));
  }
  if (node.strokes && node.strokes.length > 0) {
    raw.strokes = node.strokes.map((s) => ({ type: s.type, visible: s.visible, opacity: s.opacity, color: s.color }));
    raw.strokeWeight = safeMixed(node.strokeWeight);
    raw.strokeAlign = node.strokeAlign;
    if ('strokeTopWeight' in node) raw.strokeTopWeight = node.strokeTopWeight;
    if ('strokeRightWeight' in node) raw.strokeRightWeight = node.strokeRightWeight;
    if ('strokeBottomWeight' in node) raw.strokeBottomWeight = node.strokeBottomWeight;
    if ('strokeLeftWeight' in node) raw.strokeLeftWeight = node.strokeLeftWeight;
  }
  if (node.effects && node.effects.length > 0) {
    raw.effects = node.effects.map((e) => ({
      type: e.type,
      visible: e.visible,
      radius: e.radius,
      spread: e.spread,
      offset: e.offset,
      color: e.color,
    }));
  }

  if (node.type === 'TEXT') {
    raw.characters = node.characters;
    raw.fontSize = safeMixed(node.fontSize);
    raw.fontName = safeMixed(node.fontName);
    raw.letterSpacing = safeMixed(node.letterSpacing);
    raw.lineHeight = safeMixed(node.lineHeight);
    raw.textAlignHorizontal = node.textAlignHorizontal;
    raw.textAlignVertical = node.textAlignVertical;
  }

  if (node.children && node.children.length > 0) {
    raw.children = node.children.map(buildRawNode);
  }

  return raw;
}

async function buildPayload(node) {
  const { css, warnings } = extractCss(node);
  const dart = await generateDart(node);
  const htmlResult = await generateHtml(node);
  const compact = buildCompactNode(node);
  const preview = await exportPreviewPng(node);
  const raw = buildRawNode(node);

  // Caveats from anywhere in the subtree matter just as much as ones on the
  // selected node itself — a flattened child is exactly what makes a preview
  // stop matching the design.
  const allWarnings = warnings.concat(htmlResult.warnings).filter((w, i, a) => a.indexOf(w) === i);

  return {
    type: 'selection',
    nodeName: node.name,
    width: round(node.width),
    height: round(node.height),
    css,
    warnings: allWarnings,
    dart,
    html: htmlResult.html,
    compact,
    previewImage: preview ? preview.uri : null,
    previewCrop: preview ? preview.crop : null,
    raw,
  };
}

// Asset export is async and can take a moment on icon-heavy selections; if the
// user picks something else mid-export, this guards against a stale result
// clobbering the newer one.
let selectionGeneration = 0;

async function sendSelection() {
  const generation = ++selectionGeneration;
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'empty' });
    return;
  }
  try {
    const payload = await buildPayload(selection[0]);
    if (generation === selectionGeneration) {
      figma.ui.postMessage(payload);
    }
  } catch (e) {
    if (generation === selectionGeneration) {
      figma.ui.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
    }
  }
}

figma.on('selectionchange', sendSelection);
sendSelection();
