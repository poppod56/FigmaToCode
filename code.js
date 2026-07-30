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

// ---------- Figma variables, styles, and component instances ----------

// The name a designer actually gave a token ("color/brand/primary") is worth far
// more than a value-derived guess ("color-1e88e5"), and an instance tells us
// which parts of a screen are one reusable component instead of N lookalike
// copies. Both live behind *async* APIs, so they get resolved in a single
// pre-pass into an index keyed by node id. The synchronous CSS/HTML/Dart
// extraction further down then only ever *looks up* that index — it stays
// exactly as pure and as fast as before, and works unchanged when the index is
// empty (no variables in the file, or an older Figma API).

const variableCache = new Map();
const variableCollectionCache = new Map();
const figmaStyleCache = new Map();

// Figma moved these getters from sync to async; try the async one first and fall
// back so the plugin works on either API generation instead of throwing.
async function loadCached(cache, key, loaders) {
  if (!key || typeof key !== 'string') return null;
  if (cache.has(key)) return cache.get(key);
  let result = null;
  for (const load of loaders) {
    if (typeof load !== 'function') continue;
    try {
      result = await load(key);
    } catch (e) {
      result = null;
    }
    if (result) break;
  }
  cache.set(key, result || null);
  return result || null;
}

function variablesApi() {
  return typeof figma !== 'undefined' && figma.variables ? figma.variables : null;
}

function getVariableById(id) {
  const api = variablesApi();
  if (!api) return Promise.resolve(null);
  return loadCached(variableCache, id, [
    api.getVariableByIdAsync ? (key) => api.getVariableByIdAsync(key) : null,
    api.getVariableById ? (key) => api.getVariableById(key) : null,
  ]);
}

function getVariableCollectionById(id) {
  const api = variablesApi();
  if (!api) return Promise.resolve(null);
  return loadCached(variableCollectionCache, id, [
    api.getVariableCollectionByIdAsync ? (key) => api.getVariableCollectionByIdAsync(key) : null,
    api.getVariableCollectionById ? (key) => api.getVariableCollectionById(key) : null,
  ]);
}

function getFigmaStyleById(id) {
  if (typeof figma === 'undefined') return Promise.resolve(null);
  return loadCached(figmaStyleCache, id, [
    figma.getStyleByIdAsync ? (key) => figma.getStyleByIdAsync(key) : null,
    figma.getStyleById ? (key) => figma.getStyleById(key) : null,
  ]);
}

// boundVariables entries are either a single alias ({ type, id }) or an array of
// them aligned with fills/strokes/effects — normalize both to a flat list so
// callers never have to care which field they are reading.
function boundVariableEntries(boundVariables) {
  const entries = [];
  if (!boundVariables || typeof boundVariables !== 'object') return entries;
  Object.keys(boundVariables).forEach((field) => {
    const value = boundVariables[field];
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((alias, index) => {
        if (alias && alias.id) entries.push({ field, index, id: alias.id });
      });
    } else if (value.id) {
      entries.push({ field, index: null, id: value.id });
    }
  });
  return entries;
}

async function formatVariableValue(value, resolvedType, depth) {
  if (value && value.type === 'VARIABLE_ALIAS') {
    if (depth >= 4) return null; // guards against a cyclic alias chain
    const target = await getVariableById(value.id);
    if (!target) return null;
    return { alias: target.name, aliasToken: slugToken(target.name) };
  }
  if (resolvedType === 'COLOR' && value && typeof value.r === 'number') {
    return { value: rgbToHex(value, value.a === undefined ? 1 : value.a) };
  }
  if (resolvedType === 'FLOAT' && typeof value === 'number') return { value: round(value) };
  if (resolvedType === 'STRING' || resolvedType === 'BOOLEAN') return { value };
  return null;
}

async function describeVariable(id) {
  const variable = await getVariableById(id);
  if (!variable) return null;
  const collection = await getVariableCollectionById(variable.variableCollectionId);
  const modes = collection && collection.modes ? collection.modes : [];
  const defaultModeId = collection ? collection.defaultModeId : null;

  const modeValues = [];
  const valuesByMode = variable.valuesByMode || {};
  for (const mode of modes.length > 0 ? modes : Object.keys(valuesByMode).map((modeId) => ({ modeId, name: modeId }))) {
    if (!(mode.modeId in valuesByMode)) continue;
    const formatted = await formatVariableValue(valuesByMode[mode.modeId], variable.resolvedType, 0);
    if (!formatted) continue;
    modeValues.push({
      modeId: mode.modeId,
      modeName: mode.name,
      isDefault: mode.modeId === defaultModeId,
      value: formatted.value === undefined ? null : formatted.value,
      alias: formatted.alias || null,
      aliasToken: formatted.aliasToken || null,
    });
  }
  if (modeValues.length > 0 && !modeValues.some((mode) => mode.isDefault)) modeValues[0].isDefault = true;

  return {
    id: variable.id,
    name: variable.name,
    token: slugToken(variable.name),
    resolvedType: variable.resolvedType,
    collection: collection ? collection.name : null,
    collectionId: variable.variableCollectionId || null,
    remote: !!variable.remote,
    modeValues,
  };
}

function parseVariantName(name) {
  // Figma names a variant "Size=md, State=hover" — the only place the axis
  // names live when variantProperties isn't exposed.
  const variants = {};
  String(name || '')
    .split(',')
    .forEach((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key) variants[key] = value;
    });
  return variants;
}

async function describeInstance(node) {
  let main = null;
  try {
    if (typeof node.getMainComponentAsync === 'function') main = await node.getMainComponentAsync();
    else main = node.mainComponent || null;
  } catch (e) {
    main = null;
  }
  const set = main && main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;

  let variantProperties = {};
  const rawVariants = node.variantProperties || (main && main.variantProperties) || null;
  if (rawVariants) {
    Object.keys(rawVariants).forEach((key) => {
      if (rawVariants[key] !== null && rawVariants[key] !== undefined) {
        variantProperties[key] = String(rawVariants[key]);
      }
    });
  } else if (main && set) {
    variantProperties = parseVariantName(main.name);
  }

  const properties = {};
  if (node.componentProperties) {
    Object.keys(node.componentProperties).forEach((key) => {
      const prop = node.componentProperties[key];
      if (!prop) return;
      // Figma suffixes property keys with a unique id ("Label#123:0") — the part
      // before the "#" is the name the designer sees.
      properties[key.split('#')[0]] = {
        type: prop.type,
        value: prop.type === 'INSTANCE_SWAP' ? String(prop.value) : prop.value,
      };
    });
  }

  const componentName = set ? set.name : main ? main.name : node.name;
  return {
    instanceId: node.id,
    instanceName: node.name,
    componentId: main ? main.id : null,
    componentKey: main && main.key ? main.key : null,
    componentName,
    variantName: main ? main.name : null,
    setId: set ? set.id : null,
    setName: set ? set.name : null,
    remote: main ? !!main.remote : null,
    variantProperties,
    properties,
  };
}

async function collectBindings(node, index) {
  if (!node) return index;
  const info = { variables: [], styles: [], component: null };

  for (const entry of boundVariableEntries(node.boundVariables)) {
    const descriptor = await describeVariable(entry.id);
    if (descriptor) info.variables.push({ ...descriptor, field: entry.field, index: entry.index });
  }

  // A paint or an effect carries its own bindings too (a color variable on one
  // fill of several, a radius variable on one shadow).
  const paintLists = [
    ['fills', node.fills],
    ['strokes', node.strokes],
  ];
  for (const [listName, list] of paintLists) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (const entry of boundVariableEntries(list[i] && list[i].boundVariables)) {
        const descriptor = await describeVariable(entry.id);
        if (descriptor) info.variables.push({ ...descriptor, field: `${listName}.${entry.field}`, index: i });
      }
    }
  }
  if (Array.isArray(node.effects)) {
    for (let i = 0; i < node.effects.length; i += 1) {
      for (const entry of boundVariableEntries(node.effects[i] && node.effects[i].boundVariables)) {
        const descriptor = await describeVariable(entry.id);
        if (descriptor) info.variables.push({ ...descriptor, field: `effects.${entry.field}`, index: i });
      }
    }
  }

  const styleFields = [
    ['fill', 'fillStyleId'],
    ['stroke', 'strokeStyleId'],
    ['text', 'textStyleId'],
    ['effect', 'effectStyleId'],
    ['grid', 'gridStyleId'],
  ];
  for (const [role, prop] of styleFields) {
    const styleId = node[prop];
    if (!styleId || styleId === figma.mixed || typeof styleId !== 'string') continue;
    const style = await getFigmaStyleById(styleId);
    if (style) {
      info.styles.push({
        role,
        id: styleId,
        name: style.name,
        token: slugToken(style.name),
        styleType: style.type || null,
        remote: !!style.remote,
      });
    }
  }

  if (node.type === 'INSTANCE') info.component = await describeInstance(node);

  if (info.variables.length > 0 || info.styles.length > 0 || info.component) index.set(node.id, info);

  for (const child of node.children || []) {
    await collectBindings(child, index);
  }
  return index;
}

async function buildBindingIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    await collectBindings(node, index);
  }
  return index;
}

function variableForField(info, fields, index) {
  if (!info || info.variables.length === 0) return null;
  for (const field of fields) {
    const match = info.variables.find(
      (entry) =>
        entry.field === field && (index === undefined || index === null || entry.index === null || entry.index === index)
    );
    if (match) return match;
  }
  return null;
}

function styleForRole(info, role) {
  if (!info || info.styles.length === 0) return null;
  return info.styles.find((entry) => entry.role === role) || null;
}

// A token's identity: the variable/style it came from when there is one, so two
// different variables that happen to hold the same hex stay two tokens — and
// the same variable stays one token even where a mode makes its value differ.
function sourceKey(item) {
  if (item.variable) return `var:${item.variable.id}`;
  if (item.style) return `style:${item.style.id}`;
  return null;
}

function sourceToken(item) {
  if (item.variable) return item.variable.token;
  if (item.style) return item.style.token;
  return null;
}

// ---------- Design system extraction ----------

function slugToken(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'token';
}

function textMetricValue(value) {
  if (!value || value === figma.mixed) return null;
  if (value.unit === 'PIXELS') return `${round(value.value)}px`;
  if (value.unit === 'PERCENT') return `${round(value.value)}%`;
  if (value.unit === 'INTRINSIC_%') return `${round(value.value)}%`;
  if (value.unit === 'AUTO') return 'auto';
  return null;
}

function firstSolidPaintHex(paints) {
  if (!paints || paints === figma.mixed) return null;
  const paint = paints.find((item) => item.visible !== false && item.type === 'SOLID');
  return paint ? rgbToHex(paint.color, paint.opacity !== undefined ? paint.opacity : 1) : null;
}

function getTextStyleRuns(node) {
  if (node.type !== 'TEXT') return [];
  const fallback = {
    fontName: node.fontName,
    fontSize: node.fontSize,
    fills: node.fills,
    letterSpacing: node.letterSpacing,
    lineHeight: node.lineHeight,
    characters: node.characters || '',
  };

  const hasMixed =
    node.fontName === figma.mixed ||
    node.fontSize === figma.mixed ||
    node.fills === figma.mixed ||
    node.letterSpacing === figma.mixed ||
    node.lineHeight === figma.mixed;
  if (!hasMixed || typeof node.getStyledTextSegments !== 'function') return [fallback];

  try {
    const segments = node.getStyledTextSegments([
      'fontName',
      'fontSize',
      'fills',
      'letterSpacing',
      'lineHeight',
    ]);
    return segments && segments.length > 0 ? segments : [fallback];
  } catch (e) {
    return [fallback];
  }
}

function collectDesignSource(node, source, bindings) {
  if (!node || node.visible === false) return;

  const info = bindings ? bindings.get(node.id) || null : null;
  const textStyle = styleForRole(info, 'text');
  const fillStyle = styleForRole(info, 'fill');
  const effectStyle = styleForRole(info, 'effect');

  if (info && info.component) source.instances.push(info.component);

  if (node.type === 'TEXT') {
    const textColorVariable = variableForField(info, ['fills', 'fills.color']);
    getTextStyleRuns(node).forEach((run) => {
      if (!run.fontName || run.fontName === figma.mixed) return;
      source.textRuns.push({
        nodeId: node.id,
        nodeName: node.name,
        style: textStyle,
        colorVariable: textColorVariable,
        family: run.fontName.family,
        figmaStyle: run.fontName.style,
        weight: mapFontWeight(run.fontName.style),
        fontStyle: mapFontStyle(run.fontName.style) || 'normal',
        fontSize: run.fontSize !== undefined && run.fontSize !== figma.mixed ? round(run.fontSize) : null,
        lineHeight: textMetricValue(run.lineHeight),
        letterSpacing: textMetricValue(run.letterSpacing),
        color: firstSolidPaintHex(run.fills),
        sample: String(run.characters || node.characters || '').slice(0, 80),
      });
    });
  }

  if (node.fills && node.fills !== figma.mixed) {
    node.fills.forEach((paint, paintIndex) => {
      if (paint.visible === false) return;
      if (paint.type === 'SOLID') {
        source.colors.push({
          value: rgbToHex(paint.color, paint.opacity !== undefined ? paint.opacity : 1),
          nodeId: node.id,
          nodeName: node.name,
          role: node.type === 'TEXT' ? 'text' : 'fill',
          variable: variableForField(info, ['fills', 'fills.color'], paintIndex),
          style: paintIndex === 0 ? fillStyle : null,
        });
      } else if (paint.type && paint.type.indexOf('GRADIENT') === 0) {
        source.gradients.push({
          value: fillToBackgroundLayer(paint),
          type: paint.type,
          nodeId: node.id,
          nodeName: node.name,
          style: paintIndex === 0 ? fillStyle : null,
        });
      }
    });
  }

  const radius = getBorderRadiusCss(node);
  if (radius) {
    source.radii.push({
      value: radius,
      nodeId: node.id,
      nodeName: node.name,
      variable: variableForField(info, [
        'topLeftRadius',
        'topRightRadius',
        'bottomRightRadius',
        'bottomLeftRadius',
        'cornerRadius',
      ]),
    });
  }

  const shadow = node.type === 'TEXT' ? getTextShadowCss(node) : getBoxShadowCss(node);
  if (shadow) {
    source.shadows.push({
      value: shadow,
      nodeId: node.id,
      nodeName: node.name,
      style: effectStyle,
      variable: variableForField(info, ['effects.color', 'effects.radius', 'effects.spread']),
    });
  }

  if (node.layoutMode && node.layoutMode !== 'NONE') {
    [
      ['itemSpacing', node.itemSpacing],
      ['counterAxisSpacing', node.counterAxisSpacing],
      ['paddingTop', node.paddingTop],
      ['paddingRight', node.paddingRight],
      ['paddingBottom', node.paddingBottom],
      ['paddingLeft', node.paddingLeft],
      ['gridColumnGap', node.gridColumnGap],
      ['gridRowGap', node.gridRowGap],
    ].forEach(([field, value]) => {
      if (typeof value === 'number' && value > 0) {
        source.spacing.push({
          value: round(value),
          field,
          nodeId: node.id,
          nodeName: node.name,
          variable: variableForField(info, [field]),
        });
      }
    });
  }

  (node.children || []).forEach((child) => collectDesignSource(child, source, bindings));
}

// A variable or style, when the node has one, wins over the value-derived name
// and the value-derived identity — that is the whole point of reading them.
// Without one, this behaves exactly as it did before.
function aggregateTokens(items, keyFor, tokenFor) {
  const map = new Map();
  items.forEach((item) => {
    const key = sourceKey(item) || keyFor(item);
    if (!key) return;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        ...item,
        token: sourceToken(item) || tokenFor(item),
        origin: item.variable ? 'variable' : item.style ? 'style' : 'value',
        usageCount: 0,
        nodes: [],
      };
      map.set(key, entry);
    }
    entry.usageCount += 1;
    if (!entry.nodes.some((node) => node.id === item.nodeId)) {
      entry.nodes.push({ id: item.nodeId, name: item.nodeName });
    }
  });
  return Array.from(map.values());
}

function uniquifyTokenNames(tokens) {
  const counts = new Map();
  tokens.forEach((token) => {
    const count = (counts.get(token.token) || 0) + 1;
    counts.set(token.token, count);
    if (count > 1) token.token = `${token.token}-${count}`;
  });
  return tokens;
}

let availableFontsPromise = null;

async function getAvailableFontSet() {
  if (!figma.listAvailableFontsAsync) return null;
  if (!availableFontsPromise) {
    availableFontsPromise = figma
      .listAvailableFontsAsync()
      .then(
        (fonts) =>
          new Set(
            fonts.map((entry) => {
              const fontName = entry.fontName || entry;
              return `${fontName.family}\u0000${fontName.style}`;
            })
          )
      )
      .catch(() => null);
  }
  return availableFontsPromise;
}

// Variant values like "default" or "class" are perfectly good Figma names and
// illegal Dart identifiers, so they get a suffix rather than emitting code that
// will not compile.
const DART_RESERVED_WORDS = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'base', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'covariant', 'default', 'deferred', 'do', 'dynamic', 'else', 'enum', 'export',
  'extends', 'extension', 'external', 'factory', 'false', 'final', 'finally', 'for', 'function',
  'get', 'hide', 'if', 'implements', 'import', 'in', 'interface', 'is', 'late', 'library', 'mixin',
  'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow', 'return', 'sealed', 'set', 'show',
  'static', 'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var', 'void',
  'when', 'while', 'with', 'yield',
]);

function dartIdentifier(value) {
  const words = String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return 'token';
  const name =
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  if (DART_RESERVED_WORDS.has(name)) return `${name}Value`;
  return /^[0-9]/.test(name) ? `token${name}` : name;
}

function pascalIdentifier(value) {
  const words = String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return 'Component';
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return /^[0-9]/.test(name) ? `C${name}` : name;
}

function dartColor(value) {
  if (!value) return null;
  if (value.charAt(0) === '#') {
    const hex = value.slice(1);
    if (hex.length === 6) return `Color(0xFF${hex.toUpperCase()})`;
    return null;
  }
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\s*\)$/.exec(value);
  if (!rgba) return null;
  const channel = (n) => Number(n).toString(16).padStart(2, '0').toUpperCase();
  const alpha = channel(Math.round(Math.max(0, Math.min(1, parseFloat(rgba[4]))) * 255));
  return `Color(0x${alpha}${channel(rgba[1])}${channel(rgba[2])}${channel(rgba[3])})`;
}

// A FLOAT variable can be a length (padding, radius, font size) or a bare ratio
// (opacity) — the fields it is actually bound to are the only reliable way to
// tell, so units come from there rather than from a guess about the name.
const PX_FIELD_PATTERN = /padding|spacing|radius|gap|width|height|strokeWeight|fontSize|lineHeight|letterSpacing|paragraph/i;

function variableCssValue(variable, mode) {
  if (mode.aliasToken) return `var(--${mode.aliasToken})`;
  if (mode.value === null || mode.value === undefined) return null;
  if (variable.resolvedType === 'FLOAT') {
    return variable.fields.some((field) => PX_FIELD_PATTERN.test(field)) ? `${mode.value}px` : String(mode.value);
  }
  return String(mode.value);
}

function buildVariableCssLines(variables) {
  if (variables.length === 0) return [];
  const lines = [];
  const collections = new Map();
  variables.forEach((variable) => {
    const name = variable.collection || 'Variables';
    if (!collections.has(name)) collections.set(name, []);
    collections.get(name).push(variable);
  });

  collections.forEach((list, collectionName) => {
    lines.push(`/* Figma variables — collection "${collectionName}" */`);
    const defaults = [];
    const modeNames = [];
    list.forEach((variable) => {
      variable.modeValues.forEach((mode) => {
        if (modeNames.indexOf(mode.modeName) === -1) modeNames.push(mode.modeName);
      });
      const fallback = variable.modeValues.find((mode) => mode.isDefault) || variable.modeValues[0];
      const value = fallback ? variableCssValue(variable, fallback) : null;
      if (value !== null) defaults.push(`  --${variable.token}: ${value};`);
    });
    if (defaults.length > 0) lines.push(':root {', ...defaults, '}');

    // A second mode is a theme — expose it as a data attribute on any ancestor
    // instead of forcing a whole second stylesheet. Only tokens that actually
    // differ from the default mode belong in it.
    modeNames.forEach((modeName) => {
      const overrides = [];
      list.forEach((variable) => {
        const mode = variable.modeValues.find((entry) => entry.modeName === modeName);
        if (!mode || mode.isDefault) return;
        const value = variableCssValue(variable, mode);
        if (value === null) return;
        const fallback = variable.modeValues.find((entry) => entry.isDefault) || variable.modeValues[0];
        if (fallback && variableCssValue(variable, fallback) === value) return;
        overrides.push(`  --${variable.token}: ${value};`);
      });
      if (overrides.length > 0) {
        lines.push('', `[data-${slugToken(collectionName)}="${slugToken(modeName)}"] {`, ...overrides, '}');
      }
    });
    lines.push('');
  });
  return lines;
}

function buildComponentExport(componentLibrary) {
  if (componentLibrary.length === 0) {
    return '// No component instances found in this selection.';
  }
  const totalInstances = componentLibrary.reduce((sum, component) => sum + component.usageCount, 0);
  const lines = [
    "import 'package:flutter/material.dart';",
    '',
    `// ${componentLibrary.length} component(s), ${totalInstances} instance(s) in this selection.`,
    '// Scaffolds only — paste the generated Flutter/HTML output for each variant',
    '// into the matching build method so every instance renders from one place.',
  ];

  componentLibrary.forEach((component) => {
    const axes = Object.keys(component.variantAxes);
    const propNames = Object.keys(component.properties).filter((name) => !axes.includes(name));
    lines.push(
      '',
      `// ${component.name} — ${component.usageCount} instance(s)${component.remote ? ' (library component)' : ''}`
    );
    axes.forEach((axis) => {
      lines.push(`//   ${axis}: ${component.variantAxes[axis].join(' | ')}`);
    });
    propNames.forEach((name) => {
      lines.push(`//   ${name} (${component.properties[name].type})`);
    });

    const enums = new Map();
    axes.forEach((axis) => {
      const enumName = `${component.className}${pascalIdentifier(axis)}`;
      const used = new Set();
      const members = component.variantAxes[axis].map((value) => {
        let member = dartIdentifier(value);
        while (used.has(member)) member = `${member}_`;
        used.add(member);
        return member;
      });
      enums.set(axis, { enumName, members });
      lines.push(`enum ${enumName} { ${members.join(', ')} }`);
    });

    const params = [];
    const fields = [];
    propNames.forEach((name) => {
      const prop = component.properties[name];
      const identifier = dartIdentifier(name);
      if (prop.type === 'BOOLEAN') {
        params.push(`    this.${identifier} = false,`);
        fields.push(`  final bool ${identifier};`);
      } else if (prop.type === 'INSTANCE_SWAP') {
        params.push(`    this.${identifier},`);
        fields.push(`  final Widget? ${identifier};`);
      } else {
        params.push(`    required this.${identifier},`);
        fields.push(`  final String ${identifier};`);
      }
    });
    axes.forEach((axis) => {
      const info = enums.get(axis);
      const identifier = dartIdentifier(axis);
      params.push(`    this.${identifier} = ${info.enumName}.${info.members[0]},`);
      fields.push(`  final ${info.enumName} ${identifier};`);
    });

    lines.push(`class ${component.className} extends StatelessWidget {`);
    if (params.length === 0) {
      lines.push(`  const ${component.className}({super.key});`);
    } else {
      lines.push(`  const ${component.className}({`, '    super.key,', ...params, '  });');
    }
    lines.push(...fields);
    lines.push('', '  @override', '  Widget build(BuildContext context) {');
    lines.push('    // TODO: paste the generated widget tree for this component here.');
    lines.push('    return const SizedBox.shrink();', '  }', '}');
  });

  return lines.join('\n');
}

function buildDesignSystemExports(designSystem) {
  const cssLines = ['/* Add licensed font files before using these placeholders. */'];
  designSystem.fonts.forEach((font) => {
    font.styles.forEach((style) => {
      cssLines.push(
        `/* @font-face { font-family: '${font.family}'; font-style: ${style.fontStyle}; font-weight: ${style.weight}; src: url('./fonts/${slugToken(
          font.family
        )}-${slugToken(style.figmaStyle)}.woff2') format('woff2'); } */`
      );
    });
  });
  cssLines.push('');
  cssLines.push(...buildVariableCssLines(designSystem.variables));
  cssLines.push(':root {');
  designSystem.typography.forEach((token) => {
    cssLines.push(`  --${token.token}-family: '${token.family}';`);
    if (token.fontSize !== null) cssLines.push(`  --${token.token}-size: ${token.fontSize}px;`);
    if (token.lineHeight) cssLines.push(`  --${token.token}-line-height: ${token.lineHeight};`);
    if (token.letterSpacing) cssLines.push(`  --${token.token}-letter-spacing: ${token.letterSpacing};`);
  });
  // A variable-backed color is already declared (with all of its modes) in the
  // variables block above — redeclaring it here would pin it to one mode.
  designSystem.colors
    .filter((token) => token.origin !== 'variable')
    .forEach((token) => cssLines.push(`  --${token.token}: ${token.value};`));
  cssLines.push('}');
  designSystem.typography.forEach((token) => {
    cssLines.push(
      '',
      `.${token.token} {`,
      `  font-family: var(--${token.token}-family);`,
      `  font-weight: ${token.weight};`,
      `  font-style: ${token.fontStyle};`
    );
    if (token.fontSize !== null) cssLines.push(`  font-size: var(--${token.token}-size);`);
    if (token.lineHeight) cssLines.push(`  line-height: var(--${token.token}-line-height);`);
    if (token.letterSpacing) cssLines.push(`  letter-spacing: var(--${token.token}-letter-spacing);`);
    if (token.colorToken) cssLines.push(`  color: var(--${token.colorToken});`);
    else if (token.color) cssLines.push(`  color: ${token.color};`);
    cssLines.push('}');
  });

  const defaultFamily = designSystem.fonts.length > 0 ? designSystem.fonts[0].family : null;
  const flutterLines = [
    "import 'package:flutter/material.dart';",
    '',
    'ThemeData buildAppTheme() {',
    '  return ThemeData(',
    '    useMaterial3: true,',
  ];
  if (defaultFamily) flutterLines.push(`    fontFamily: '${defaultFamily.replace(/'/g, "\\'")}',`);
  flutterLines.push('  );', '}');

  // Variable-backed tokens keep the designer's own names, which is what makes
  // the generated theme reviewable against Figma instead of a wall of hexes.
  const colorVariables = designSystem.variables.filter((variable) => variable.resolvedType === 'COLOR');
  if (colorVariables.length > 0) {
    flutterLines.push('', 'abstract final class AppColors {');
    colorVariables.forEach((variable) => {
      const defaultMode = variable.modeValues.find((mode) => mode.isDefault) || variable.modeValues[0];
      if (!defaultMode) return;
      if (defaultMode.aliasToken) {
        flutterLines.push(`  static const ${dartIdentifier(variable.token)} = ${dartIdentifier(defaultMode.aliasToken)};`);
        return;
      }
      const color = dartColor(defaultMode.value);
      if (color) flutterLines.push(`  static const ${dartIdentifier(variable.token)} = ${color};`);
      const others = variable.modeValues.filter((mode) => !mode.isDefault);
      others.forEach((mode) => {
        const modeColor = dartColor(mode.value);
        if (modeColor) {
          flutterLines.push(
            `  static const ${dartIdentifier(`${variable.token}-${mode.modeName}`)} = ${modeColor}; // mode: ${mode.modeName}`
          );
        }
      });
    });
    flutterLines.push('}');
  }

  const numberVariables = designSystem.variables.filter(
    (variable) =>
      variable.resolvedType === 'FLOAT' && variable.fields.some((field) => PX_FIELD_PATTERN.test(field))
  );
  if (numberVariables.length > 0) {
    flutterLines.push('', 'abstract final class AppSpacing {');
    numberVariables.forEach((variable) => {
      const defaultMode = variable.modeValues.find((mode) => mode.isDefault) || variable.modeValues[0];
      if (!defaultMode || typeof defaultMode.value !== 'number') return;
      // Typed as double on purpose: an untyped `= 16` is an int const, and Dart
      // will not implicitly widen it where a double is expected.
      flutterLines.push(`  static const double ${dartIdentifier(variable.token)} = ${defaultMode.value};`);
    });
    flutterLines.push('}');
  }

  flutterLines.push('', 'abstract final class AppTypography {');
  designSystem.typography.forEach((token) => {
    flutterLines.push(`  static const ${dartIdentifier(token.token)} = TextStyle(`);
    flutterLines.push(`    fontFamily: '${token.family.replace(/'/g, "\\'")}',`);
    flutterLines.push(`    fontWeight: FontWeight.w${token.weight},`);
    if (token.fontStyle === 'italic' || token.fontStyle === 'oblique') {
      flutterLines.push('    fontStyle: FontStyle.italic,');
    }
    if (token.fontSize !== null) flutterLines.push(`    fontSize: ${token.fontSize},`);
    if (token.lineHeight && token.lineHeight.endsWith('px') && token.fontSize) {
      flutterLines.push(`    height: ${round(parseFloat(token.lineHeight) / token.fontSize)},`);
    } else if (token.lineHeight && token.lineHeight.endsWith('%')) {
      flutterLines.push(`    height: ${round(parseFloat(token.lineHeight) / 100)},`);
    }
    if (token.letterSpacing && token.letterSpacing.endsWith('px')) {
      flutterLines.push(`    letterSpacing: ${parseFloat(token.letterSpacing)},`);
    }
    const color = dartColor(token.color);
    if (color) flutterLines.push(`    color: ${color},`);
    flutterLines.push('  );');
  });
  flutterLines.push('}', '', '/*', 'pubspec.yaml', 'flutter:', '  fonts:');
  designSystem.fonts.forEach((font) => {
    flutterLines.push(`    - family: ${font.family}`, '      fonts:');
    font.styles.forEach((style) => {
      flutterLines.push(
        `        - asset: assets/fonts/${slugToken(font.family)}-${slugToken(style.figmaStyle)}.ttf`,
        `          weight: ${style.weight}`
      );
      if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') flutterLines.push('          style: italic');
    });
  });
  flutterLines.push('*/');

  return {
    css: cssLines.join('\n'),
    flutter: flutterLines.join('\n'),
    components: buildComponentExport(designSystem.componentLibrary),
    json: JSON.stringify(
      {
        name: designSystem.name,
        coverage: designSystem.coverage,
        fonts: designSystem.fonts,
        variables: designSystem.variables,
        styles: designSystem.styles,
        typography: designSystem.typography,
        colors: designSystem.colors,
        gradients: designSystem.gradients,
        radii: designSystem.radii,
        shadows: designSystem.shadows,
        spacing: designSystem.spacing,
        componentLibrary: designSystem.componentLibrary,
        components: designSystem.components,
      },
      null,
      2
    ),
  };
}

// Accepts one node or a whole multi-selection — a design system is only really
// meaningful across everything the user picked, not one frame at a time.
async function buildDesignSystem(input, prebuiltBindings) {
  const nodes = Array.isArray(input) ? input.filter(Boolean) : input ? [input] : [];
  const source = {
    textRuns: [],
    colors: [],
    gradients: [],
    radii: [],
    shadows: [],
    spacing: [],
    instances: [],
  };
  const bindings = prebuiltBindings || (await buildBindingIndex(nodes));
  nodes.forEach((node) => collectDesignSource(node, source, bindings));
  const available = await getAvailableFontSet();

  const typography = uniquifyTokenNames(aggregateTokens(
    source.textRuns,
    (item) =>
      [
        item.family,
        item.figmaStyle,
        item.fontSize,
        item.lineHeight,
        item.letterSpacing,
        item.color,
      ].join('|'),
    (item) =>
      `type-${slugToken(item.family)}-${item.fontSize === null ? 'mixed' : item.fontSize}-${item.weight}${
        item.fontStyle === 'normal' ? '' : `-${item.fontStyle}`
      }`
  ));
  const fontMap = new Map();
  source.textRuns.forEach((run) => {
    let font = fontMap.get(run.family);
    if (!font) {
      font = { family: run.family, usageCount: 0, available: false, styles: [] };
      fontMap.set(run.family, font);
    }
    font.usageCount += 1;
    let style = font.styles.find((item) => item.figmaStyle === run.figmaStyle);
    if (!style) {
      style = {
        figmaStyle: run.figmaStyle,
        weight: run.weight,
        fontStyle: run.fontStyle,
        usageCount: 0,
        available: available ? available.has(`${run.family}\u0000${run.figmaStyle}`) : null,
      };
      font.styles.push(style);
    }
    style.usageCount += 1;
  });
  const fonts = Array.from(fontMap.values()).map((font) => {
    font.available = font.styles.every((style) => style.available === true)
      ? true
      : font.styles.some((style) => style.available === false)
        ? false
        : null;
    return font;
  });

  const colors = aggregateTokens(
    source.colors,
    (item) => item.value,
    (item) => `color-${slugToken(item.value.replace('#', ''))}`
  );
  const gradients = aggregateTokens(
    source.gradients,
    (item) => item.value,
    (_item) => `gradient-${String(source.gradients.indexOf(_item) + 1).padStart(2, '0')}`
  );
  const radii = aggregateTokens(
    source.radii,
    (item) => item.value,
    (item) => `radius-${slugToken(item.value)}`
  );
  const shadows = aggregateTokens(
    source.shadows,
    (item) => item.value,
    (_item) => `shadow-${String(source.shadows.indexOf(_item) + 1).padStart(2, '0')}`
  );
  const spacing = aggregateTokens(
    source.spacing,
    (item) => String(item.value),
    (item) => `space-${slugToken(item.value)}`
  ).sort((a, b) => a.value - b.value);

  const componentMap = new Map();
  function addUsage(token, kind) {
    token.nodes.forEach((usedNode) => {
      let component = componentMap.get(usedNode.id);
      if (!component) {
        component = {
          nodeId: usedNode.id,
          nodeName: usedNode.name,
          typography: [],
          colors: [],
          gradients: [],
          radii: [],
          shadows: [],
          spacing: [],
        };
        componentMap.set(usedNode.id, component);
      }
      if (component[kind].indexOf(token.token) === -1) component[kind].push(token.token);
    });
  }
  typography.forEach((token) => addUsage(token, 'typography'));
  colors.forEach((token) => addUsage(token, 'colors'));
  gradients.forEach((token) => addUsage(token, 'gradients'));
  radii.forEach((token) => addUsage(token, 'radii'));
  shadows.forEach((token) => addUsage(token, 'shadows'));
  spacing.forEach((token) => addUsage(token, 'spacing'));

  // Let a type style point at the color token instead of restating the hex, so
  // the exported CSS/theme has one source of truth per color.
  const colorTokenByValue = new Map();
  colors.forEach((token) => {
    if (!colorTokenByValue.has(token.value)) colorTokenByValue.set(token.value, token);
  });
  typography.forEach((token) => {
    const colorToken = token.color ? colorTokenByValue.get(token.color) : null;
    token.colorToken = colorToken && colorToken.origin !== 'value' ? colorToken.token : null;
  });

  const variables = collectUsedVariables(bindings);
  const styles = collectUsedStyles(bindings);
  const componentLibrary = buildComponentLibrary(source.instances);

  const tokenized = [].concat(typography, colors, gradients, radii, shadows, spacing);
  const boundCount = tokenized.filter((token) => token.origin !== 'value').length;
  const coverage = {
    total: tokenized.length,
    bound: boundCount,
    unbound: tokenized.length - boundCount,
    ratio: tokenized.length === 0 ? 0 : round((boundCount / tokenized.length) * 100),
  };

  const designSystem = {
    name: nodes.length === 1 ? nodes[0].name : `${nodes.length} selected layers`,
    fonts,
    typography,
    colors,
    gradients,
    radii,
    shadows,
    spacing,
    variables,
    styles,
    componentLibrary,
    coverage,
    components: Array.from(componentMap.values()),
  };
  designSystem.exports = buildDesignSystemExports(designSystem);
  return designSystem;
}

function collectUsedVariables(bindings) {
  const map = new Map();
  bindings.forEach((info, nodeId) => {
    info.variables.forEach((entry) => {
      let variable = map.get(entry.id);
      if (!variable) {
        variable = {
          id: entry.id,
          name: entry.name,
          token: entry.token,
          resolvedType: entry.resolvedType,
          collection: entry.collection,
          collectionId: entry.collectionId,
          remote: entry.remote,
          modeValues: entry.modeValues,
          fields: [],
          usageCount: 0,
          nodes: [],
        };
        map.set(entry.id, variable);
      }
      variable.usageCount += 1;
      if (variable.fields.indexOf(entry.field) === -1) variable.fields.push(entry.field);
      if (variable.nodes.indexOf(nodeId) === -1) variable.nodes.push(nodeId);
    });
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function collectUsedStyles(bindings) {
  const map = new Map();
  bindings.forEach((info, nodeId) => {
    info.styles.forEach((entry) => {
      let style = map.get(entry.id);
      if (!style) {
        style = { ...entry, roles: [], usageCount: 0, nodes: [] };
        delete style.role;
        map.set(entry.id, style);
      }
      style.usageCount += 1;
      if (style.roles.indexOf(entry.role) === -1) style.roles.push(entry.role);
      if (style.nodes.indexOf(nodeId) === -1) style.nodes.push(nodeId);
    });
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Groups instances back into the component (or component set) they came from, so
// twelve buttons on a screen read as one component used twelve ways instead of
// twelve unrelated frames.
function buildComponentLibrary(instances) {
  const map = new Map();
  instances.forEach((instance) => {
    const key = instance.setId || instance.componentId || instance.componentName;
    if (!key) return;
    let component = map.get(key);
    if (!component) {
      component = {
        key,
        name: instance.componentName,
        className: pascalIdentifier(instance.componentName),
        componentKey: instance.componentKey,
        remote: instance.remote,
        isVariantSet: !!instance.setId,
        variantAxes: {},
        properties: {},
        instances: [],
        usageCount: 0,
      };
      map.set(key, component);
    }
    component.usageCount += 1;
    component.instances.push({
      nodeId: instance.instanceId,
      nodeName: instance.instanceName,
      variantName: instance.variantName,
      variantProperties: instance.variantProperties,
      properties: instance.properties,
    });
    Object.keys(instance.variantProperties).forEach((axis) => {
      if (!component.variantAxes[axis]) component.variantAxes[axis] = [];
      const value = instance.variantProperties[axis];
      if (component.variantAxes[axis].indexOf(value) === -1) component.variantAxes[axis].push(value);
    });
    Object.keys(instance.properties).forEach((name) => {
      const prop = instance.properties[name];
      if (!component.properties[name]) component.properties[name] = { type: prop.type, values: [] };
      const value = String(prop.value);
      if (component.properties[name].values.indexOf(value) === -1) {
        component.properties[name].values.push(value);
      }
    });
  });
  return Array.from(map.values()).sort((a, b) => b.usageCount - a.usageCount);
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

// ---------- Responsive (fluid) mode ----------
//
// Opt-in, additive layer on top of the fixed-pixel output above. It never
// guesses a breakpoint — it translates the exact per-node resize behavior
// Figma already records (layoutSizingHorizontal/Vertical on auto-layout
// children, `constraints` on freely-positioned ones) into the equivalent
// fluid CSS. extractCss/getAutoLayoutCss/etc. above stay untouched; these
// functions only ever mutate a copy of the css object a caller already built,
// and only when that caller explicitly asks for it.

// The outermost node of an export: shrinks below its design width instead of
// staying pinned to it, but never grows past what was actually designed.
function applyRootFluidCss(css, node) {
  css.width = '100%';
  css['max-width'] = `${round(node.width)}px`;
}

// A flex/grid child whose Figma sizing is FILL or HUG on the axis that matches
// the parent's main axis: dropping the fixed dimension lets flex-grow (FILL,
// already emitted unconditionally above) or the browser's own content sizing
// (HUG) take over instead of pinning it to the size captured in this file.
function applyFluidFlexSizing(css, node, parent) {
  const mainHorizontal = parent.layoutMode === 'HORIZONTAL';
  const mainSizing = mainHorizontal ? node.layoutSizingHorizontal : node.layoutSizingVertical;
  const crossSizing = mainHorizontal ? node.layoutSizingVertical : node.layoutSizingHorizontal;
  if (mainSizing === 'FILL' || mainSizing === 'HUG') delete css[mainHorizontal ? 'width' : 'height'];
  // Cross-axis stretch is already flagged as align-self: stretch above; a
  // fixed size alongside it is redundant once the layout is allowed to flex.
  if (crossSizing === 'FILL' || node.layoutAlign === 'STRETCH') delete css[mainHorizontal ? 'height' : 'width'];
}

// Same idea for a CSS Grid child — its own layoutSizingHorizontal/Vertical and
// grid alignment already live on the node itself, no parent axis lookup needed.
function applyFluidGridSizing(css, node) {
  if (node.layoutSizingHorizontal === 'FILL' || node.layoutSizingHorizontal === 'HUG' || node.gridChildHorizontalAlign === 'STRETCH') {
    delete css.width;
  }
  if (node.layoutSizingVertical === 'FILL' || node.layoutSizingVertical === 'HUG' || node.gridChildVerticalAlign === 'STRETCH') {
    delete css.height;
  }
}

// A freely-positioned child (non-auto-layout parent, or flagged "Absolute
// position" inside one) — this is exactly what Figma's Constraints panel
// describes, translated one-for-one into the equivalent CSS anchoring.
// `off` is the child's already-computed offset within `parent` (the same
// value used to set css.left/top just above) — recomputing it here instead
// would skip the border-inset adjustment the caller already applied and drift
// a few pixels off on a stroked parent.
function applyFluidConstraintCss(css, node, parent, off) {
  const constraints = node.constraints;
  if (!constraints || !parent || !off) return;

  switch (constraints.horizontal) {
    case 'MAX':
      delete css.left;
      css.right = `${round(parent.width - off.left - node.width)}px`;
      break;
    case 'CENTER':
      css.left = '50%';
      css['margin-left'] = `${round(-node.width / 2)}px`;
      break;
    case 'STRETCH':
      css.right = `${round(parent.width - off.left - node.width)}px`;
      delete css.width;
      break;
    case 'SCALE':
      css.left = `${round((off.left / parent.width) * 100)}%`;
      css.width = `${round((node.width / parent.width) * 100)}%`;
      break;
    default:
      break; // MIN (default) — today's left/width stands unchanged.
  }

  switch (constraints.vertical) {
    case 'MAX':
      delete css.top;
      css.bottom = `${round(parent.height - off.top - node.height)}px`;
      break;
    case 'CENTER':
      css.top = '50%';
      css['margin-top'] = `${round(-node.height / 2)}px`;
      break;
    case 'STRETCH':
      css.bottom = `${round(parent.height - off.top - node.height)}px`;
      delete css.height;
      break;
    case 'SCALE':
      css.top = `${round((off.top / parent.height) * 100)}%`;
      css.height = `${round((node.height / parent.height) * 100)}%`;
      break;
    default:
      break;
  }
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

// ---------- Responsive (fluid) Dart ----------
//
// Dart equivalents of the CSS transforms above, for the same two situations:
// an auto-layout child sized FILL/HUG on its parent's main axis, and a
// freely-positioned child governed by Figma's `constraints`. Grid children
// are intentionally left out for v1 — Figma GRID has no native Flutter
// widget, so it's already hand-rolled as a fixed Stack of Positioned
// children; making that fluid needs the same percentage math as SCALE below
// and was cut to keep this change reviewable.

// The outermost widget: Flutter has no literal "100% width" the way CSS
// does, so a ConstrainedBox capping at the design width plus the Container's
// own width line being omitted (see omitWidth below) is the equivalent —
// it sizes down to whatever the parent gives it, never up past the design.
function fluidRootWrap(widget, node) {
  return `ConstrainedBox(\n    constraints: const BoxConstraints(maxWidth: ${round(node.width)}),\n    child: ${widget},\n  )`;
}

// Alignment(-1..1, -1..1) is Flutter's own percentage-of-box coordinate
// system — this is the same "% of parent" math as the CSS SCALE branch,
// just expressed the way Align already expects it.
function dartAlignmentFraction(off, size, parentSize) {
  return round(((off + size / 2) / parentSize) * 2 - 1);
}

// A freely-positioned child with non-default constraints. Returns null for
// the common MIN/MIN case so the caller falls back to today's plain
// Positioned(left:, top:, child:) untouched.
function dartFluidPositioned(child, parent, off, pad, innerWidget) {
  const h = (child.constraints && child.constraints.horizontal) || 'MIN';
  const v = (child.constraints && child.constraints.vertical) || 'MIN';
  if (h === 'MIN' && v === 'MIN') return null;

  if (h === 'SCALE' || v === 'SCALE') {
    const widthFactor = round(child.width / parent.width);
    const heightFactor = round(child.height / parent.height);
    const alignX = dartAlignmentFraction(off.left, child.width, parent.width);
    const alignY = dartAlignmentFraction(off.top, child.height, parent.height);
    return (
      `Positioned.fill(\n${pad}      child: Align(\n` +
      `${pad}        alignment: const Alignment(${alignX}, ${alignY}),\n` +
      `${pad}        child: FractionallySizedBox(\n` +
      `${pad}          widthFactor: ${widthFactor},\n` +
      `${pad}          heightFactor: ${heightFactor},\n` +
      `${pad}          child: ${innerWidget},\n` +
      `${pad}        ),\n${pad}      ),\n${pad}    )`
    );
  }

  const edges = [];
  if (h === 'MAX') edges.push(`right: ${round(parent.width - off.left - child.width)}`);
  else if (h === 'STRETCH') {
    edges.push(`left: ${round(off.left)}`, `right: ${round(parent.width - off.left - child.width)}`);
  } else if (h === 'CENTER') edges.push('left: 0', 'right: 0');
  else edges.push(`left: ${round(off.left)}`);

  if (v === 'MAX') edges.push(`bottom: ${round(parent.height - off.top - child.height)}`);
  else if (v === 'STRETCH') {
    edges.push(`top: ${round(off.top)}`, `bottom: ${round(parent.height - off.top - child.height)}`);
  } else if (v === 'CENTER') edges.push('top: 0', 'bottom: 0');
  else edges.push(`top: ${round(off.top)}`);

  const wrappedChild = h === 'CENTER' || v === 'CENTER' ? `Center(child: ${innerWidget})` : innerWidget;
  const edgeLines = edges.map((edge) => `${pad}      ${edge},`).join('\n');
  return `Positioned(\n${edgeLines}\n${pad}      child: ${wrappedChild},\n${pad}    )`;
}

// One child of a Stack (either the non-auto-layout root case or the
// "Absolute position" overlay case inside an auto-layout frame) — both call
// sites below share this so the fluid-vs-fixed branch only lives in one place.
function dartPositionedChild(parent, child, off, pad, indent, assets, responsive) {
  const childOptions = responsive ? { responsive: true, parent } : undefined;
  const childWidget = generateDartForNode(child, indent + 3, assets, childOptions);
  if (responsive) {
    const positioned = dartFluidPositioned(child, parent, off, pad, childWidget);
    if (positioned) return `${pad}    ${positioned}`;
  }
  return `${pad}    Positioned(\n${pad}      left: ${round(off.left)},\n${pad}      top: ${round(
    off.top
  )},\n${pad}      child: ${childWidget},\n${pad}    )`;
}

function generateDartForNode(node, indent, assets, options) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  const name = sanitizeVarName(node.name);
  const asset = assets && assets.get(node.id);
  const responsive = !!(options && options.responsive);
  const parent = responsive ? options.parent || null : null;

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
        return dartPositionedChild(node, child, off, pad, indent, assets, responsive);
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
        const childOptions = responsive ? { responsive: true, parent: node } : undefined;
        let childWidget = generateDartForNode(child, indent + 2, assets, childOptions);
        if (responsive) {
          // FILL on the main axis needs Expanded to actually claim the extra
          // space — flex-grow's Dart equivalent, and the one case dropping the
          // fixed dimension inside generateDartForNode isn't enough by itself.
          const mainSizing = node.layoutMode === 'HORIZONTAL' ? child.layoutSizingHorizontal : child.layoutSizingVertical;
          if (mainSizing === 'FILL') {
            childWidget = `Expanded(\n${pad}    child: ${childWidget},\n${pad}  )`;
          }
        }
        parts.push(`${pad}    ${childWidget}`);
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
          return dartPositionedChild(node, child, off, pad, indent, assets, responsive);
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

  // Which dimensions to drop for a fluid child (asset exports always keep
  // their exact rasterized size, fluid or not).
  let omitWidth = false;
  let omitHeight = false;
  if (responsive && !asset) {
    if (!parent) {
      // Root: an explicit width here would make the wrapping ConstrainedBox
      // in generateDart a no-op, since Container's own width wins over an
      // ancestor's constraints. Height stays fixed for v1, same as the CSS
      // root treatment in applyRootFluidCss.
      omitWidth = true;
    } else {
      const isAutoLayoutParent = !!(parent.layoutMode && parent.layoutMode !== 'NONE');
      const isFreePositioned = !isAutoLayoutParent || node.layoutPositioning === 'ABSOLUTE';
      if (isFreePositioned && node.constraints) {
        if (node.constraints.horizontal === 'STRETCH' || node.constraints.horizontal === 'SCALE') omitWidth = true;
        if (node.constraints.vertical === 'STRETCH' || node.constraints.vertical === 'SCALE') omitHeight = true;
      } else if (isAutoLayoutParent) {
        const mainHorizontal = parent.layoutMode === 'HORIZONTAL';
        const mainSizing = mainHorizontal ? node.layoutSizingHorizontal : node.layoutSizingVertical;
        const crossSizing = mainHorizontal ? node.layoutSizingVertical : node.layoutSizingHorizontal;
        if (mainSizing === 'FILL' || mainSizing === 'HUG') {
          if (mainHorizontal) omitWidth = true;
          else omitHeight = true;
        }
        if (crossSizing === 'FILL' || node.layoutAlign === 'STRETCH') {
          if (mainHorizontal) omitHeight = true;
          else omitWidth = true;
        }
      }
    }
  }
  const widthLine = omitWidth ? '' : `\n${pad}  width: ${round(node.width)},`;
  const heightLine = omitHeight ? '' : `\n${pad}  height: ${round(node.height)},`;

  let widget =
    `// ${name}\n` +
    `${pad}Container(${widthLine}${heightLine}${decoCode}${paddingCode}\n` +
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

// `options.withResponsive` is opt-in and additive: without it, this returns a
// plain string exactly as before (existing callers, including the regression
// test's `assert.match(assetDart, ...)`, depend on that shape). With it, the
// asset export still only runs once — only the string-building step repeats.
async function generateDart(node, options) {
  const assets = new Map();
  await collectFlutterAssets(node, assets);
  const imports = [`import 'package:flutter/material.dart';`];
  if (assets.size > 0) imports.unshift(`import 'dart:convert';`);
  const baseName = sanitizeVarName(node.name);
  const functionName = `build${baseName.charAt(0).toUpperCase()}${baseName.slice(1)}`;

  const build = (responsive) => {
    let widget = generateDartForNode(node, 1, assets, responsive ? { responsive: true } : undefined);
    if (responsive) widget = fluidRootWrap(widget, node);
    return `${imports.join('\n')}\n\nWidget ${functionName}() {\n  return ${widget};\n}`;
  };

  const fixed = build(false);
  if (!options || !options.withResponsive) return fixed;
  return { dart: fixed, responsiveDart: build(true) };
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

function generateHtmlTree(node, usedNames, rules, warnings, indent, assets, posOverride, flexChild, gridChild, options) {
  const pad = '  '.repeat(indent);
  const className = toClassName(node.name, node.type, usedNames);
  const { css, warnings: nodeWarnings } = extractCss(node);
  nodeWarnings.forEach((w) => warnings.push(w));

  // `options.parent` is only set once this call is no longer the root — see
  // the recursive call below, which is the sole place it gets threaded down.
  const responsive = !!(options && options.responsive);
  const parent = responsive ? options.parent || null : null;
  const asset = assets.get(node.id);

  if (responsive && !asset) {
    if (!parent) applyRootFluidCss(css, node);
  }

  // A non-auto-layout Figma frame positions children freely by x/y (can
  // overlap, float anywhere) — normal HTML block flow can't reproduce that,
  // so such children get pinned with position: absolute + the real offset.
  if (posOverride) {
    css.position = 'absolute';
    css.left = `${round(posOverride.left)}px`;
    css.top = `${round(posOverride.top)}px`;
    if (responsive && !asset) applyFluidConstraintCss(css, node, parent, posOverride);
  }

  if (flexChild) {
    // CSS flex items shrink below their stated size by default; Figma
    // auto-layout children never do unless explicitly set to fill. Without
    // this, every fixed-width child silently gets squeezed.
    css['flex-shrink'] = '0';
    if (node.layoutGrow === 1) css['flex-grow'] = '1';
    if (node.layoutAlign === 'STRETCH') css['align-self'] = 'stretch';
    if (responsive && !asset && parent) applyFluidFlexSizing(css, node, parent);
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
    if (responsive && !asset) applyFluidGridSizing(css, node);
  }

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
          childIsGridItem,
          responsive ? { responsive: true, parent: node } : undefined
        );
      })
      .join('\n');
    return `${pad}<div class="${className}">\n${childrenHtml}\n${pad}</div>`;
  }
  return `${pad}<div class="${className}"></div>`;
}

// Shared by both the fixed and the fluid build below — same tree walk, same
// asset map (exportAsync already ran once by the time this is called), only
// the `responsive` flag differs.
function buildHtmlDocument(node, assets, responsive) {
  const usedNames = new Set();
  const rules = [];
  const warnings = [];
  const body = generateHtmlTree(
    node,
    usedNames,
    rules,
    warnings,
    0,
    assets,
    null,
    false,
    false,
    responsive ? { responsive: true } : undefined
  );

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

async function generateHtml(node) {
  const assets = new Map();
  await collectAssets(node, assets);

  const fixed = buildHtmlDocument(node, assets, false);
  const fluid = buildHtmlDocument(node, assets, true);
  return {
    html: fixed.html,
    warnings: fixed.warnings,
    responsiveHtml: fluid.html,
  };
}

// ---------- Compact JSON for AI ----------

function buildCompactNode(node, bindings) {
  const compact = {
    id: node.id,
    type: node.type,
    name: node.name,
    width: round(node.width),
    height: round(node.height),
  };

  const info = bindings ? bindings.get(node.id) || null : null;
  if (info) {
    if (info.component) compact.component = info.component;
    if (info.styles.length > 0) compact.styles = info.styles.map((style) => ({ role: style.role, name: style.name }));
    if (info.variables.length > 0) {
      compact.variables = info.variables.map((variable) => ({ field: variable.field, name: variable.name }));
    }
  }

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
      const childCompact = buildCompactNode(child, bindings);
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
// This is what the debug "Connect" button ships, so debugging a
// mismatch doesn't depend on guessing which property to ask the user to check.
function safeMixed(value) {
  return value === figma.mixed ? 'MIXED' : value;
}

function buildRawNode(node, bindings) {
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

  const info = bindings ? bindings.get(node.id) || null : null;
  if (info) {
    if (info.component) raw.component = info.component;
    if (info.styles.length > 0) raw.styles = info.styles;
    if (info.variables.length > 0) {
      raw.boundVariables = info.variables.map((variable) => ({
        field: variable.field,
        index: variable.index,
        name: variable.name,
        token: variable.token,
        resolvedType: variable.resolvedType,
        collection: variable.collection,
      }));
    }
  }

  if (node.children && node.children.length > 0) {
    raw.children = node.children.map((child) => buildRawNode(child, bindings));
  }

  return raw;
}

async function buildNodePayload(node, bindings, extraWarnings) {
  const { css, warnings } = extractCss(node);
  const dartResult = await generateDart(node, { withResponsive: true });
  const htmlResult = await generateHtml(node);
  const compact = buildCompactNode(node, bindings);
  const preview = await exportPreviewPng(node);
  const raw = buildRawNode(node, bindings);

  // Caveats from anywhere in the subtree matter just as much as ones on the
  // selected node itself — a flattened child is exactly what makes a preview
  // stop matching the design.
  const allWarnings = warnings
    .concat(htmlResult.warnings, extraWarnings || [])
    .filter((w, i, a) => a.indexOf(w) === i);

  // Fluid variant of the CSS tab's flat single-node rule: from that view this
  // selected node *is* the root, so it gets the same treatment generateHtml's
  // root call gets — see applyRootFluidCss.
  const responsiveCss = { ...css };
  applyRootFluidCss(responsiveCss, node);

  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    width: round(node.width),
    height: round(node.height),
    css,
    warnings: allWarnings,
    dart: dartResult.dart,
    html: htmlResult.html,
    compact,
    // Opt-in fluid export — see plan doc / code comments near
    // applyRootFluidCss, applyFluidFlexSizing, applyFluidConstraintCss,
    // fluidRootWrap, dartFluidPositioned. Never used unless the UI's
    // "Responsive (fluid)" toggle is on; the keys above are the unchanged
    // fixed-pixel output.
    responsive: {
      css: responsiveCss,
      dart: dartResult.responsiveDart,
      html: htmlResult.responsiveHtml,
    },
    previewImage: preview ? preview.uri : null,
    previewCrop: preview ? preview.crop : null,
    raw,
  };
}

// Generating code for every node of a huge multi-selection means one PNG export
// and one full subtree walk each — past this many, the design system still
// covers everything selected but per-node code stops at the cap.
const MAX_CODE_NODES = 8;

async function buildSelectionPayload(nodes) {
  // One binding pre-pass for the whole selection: the async variable/style/
  // component lookups are cached across every node, so a 20-layer selection
  // resolves each shared token exactly once.
  const bindings = await buildBindingIndex(nodes);
  const designSystem = await buildDesignSystem(nodes, bindings);

  const fontWarnings = designSystem.fonts
    .filter((font) => font.available === false)
    .map(
      (font) =>
        `"${font.family}": one or more font styles are unavailable in Figma; HTML/Flutter will fall back until the font files are installed`
    );

  const coded = nodes.slice(0, MAX_CODE_NODES);
  const payloads = [];
  for (const node of coded) {
    payloads.push(await buildNodePayload(node, bindings, fontWarnings));
  }

  return {
    type: 'selection',
    nodeName: payloads.length > 0 ? payloads[0].nodeName : '',
    selectionCount: nodes.length,
    skippedCount: Math.max(0, nodes.length - coded.length),
    skippedNames: nodes.slice(coded.length).map((node) => node.name),
    nodes: payloads,
    designSystem,
  };
}

// Asset export is async and can take a moment on icon-heavy selections; if the
// user picks something else mid-export, this guards against a stale result
// clobbering the newer one.
let selectionGeneration = 0;

async function sendSelection() {
  const generation = ++selectionGeneration;
  // Variables and styles are editable while the plugin is open, so resolve them
  // fresh per selection rather than serving a rename from cache. The cache still
  // does its job *within* one selection, where the same token is hit repeatedly.
  variableCache.clear();
  variableCollectionCache.clear();
  figmaStyleCache.clear();
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'empty' });
    return;
  }
  try {
    const payload = await buildSelectionPayload(selection.slice());
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
