import * as Engine from "../engine.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const rect = (value) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
const sameRect = (a, b) => a && b && ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= 0.1);
const outputName = (output) => String(output?.name ?? "");
const windowKey = (window) => String(window.internalId);

export function createController(host) {
  const { workspace, defer, log = () => {}, config = () => undefined, debug = false, toast = null } = host;
  const contexts = new Map();
  const records = new Map();
  const outputs = new Map();
  const defaultMode = ["binary", "columns", "horizontal"].includes(config("DefaultLayout", "binary"))
    ? config("DefaultLayout", "binary") : "binary";
  let nextWindowId = 1;
  let nextOutputId = 1;
  let state = null;
  let context = "";
  let enabled = true;
  let applying = false;
  let pending = false;
  let interaction = null;
  let pendingAction = null;
  let pendingActivation = null;
  let spreadResize = config("SpreadResize", true) !== false;
  const warnings = new Set();

  function report(safe, detail) {
    // Default diagnostics never contain window titles or other user content;
    // debug mode appends the detail (titles, size limits) and may toast it.
    const text = debug && detail ? `${safe} Debug detail: ${detail}` : safe;
    if (warnings.has(text)) return;
    warnings.add(text);
    log(text);
    if (debug && toast) {
      try { toast("ktiler", text); } catch (error) { /* A failed notification must never disturb tiling. */ }
    }
  }
  function connect(signal, callback) {
    if (signal?.connect) signal.connect(callback);
  }
  function queue() {
    if (pending || !enabled) return;
    pending = true;
    defer(() => {
      pending = false;
      if (!enabled || interaction) return;
      try { reconcile(); } catch (error) { enabled = false; log(`Paused after error: ${error.stack || error}`); }
    });
  }
  function currentKey() {
    return `${workspace.currentDesktop?.id ?? "default"}|${workspace.currentActivity ?? ""}`;
  }
  function eligible(window) {
    if (!window || window.deleted || window.managed === false || !window.normalWindow
      || window.dialog || window.transient || window.specialWindow || !window.resizeable
      || !window.moveable || window.minimized || window.fullScreen) return false;
    const desktops = window.desktops || [];
    const activities = window.activities || [];
    return (window.onAllDesktops || !desktops.length || desktops.some((desktop) => desktop.id === workspace.currentDesktop?.id))
      && (!activities.length || activities.includes(workspace.currentActivity));
  }
  function emptyState() {
    return {
      displays: [], activeDisplayId: null, nextDisplayId: 1, nextWindowId,
      spreadResize, message: "",
    };
  }
  function outputList() {
    return Array.from(workspace.screenOrder || workspace.screens || []);
  }
  function bounds(output) {
    return rect(workspace.clientArea(host.maximizeArea, output, workspace.currentDesktop));
  }
  function snapshot(window) {
    return {
      geometry: rect(window.frameGeometry), tile: window.tile,
      maximizeMode: window.maximizeMode || 0,
    };
  }
  function watch(window) {
    const key = windowKey(window);
    if (records.has(key)) return records.get(key);
    const record = {
      id: nextWindowId++, window, original: null, output: outputName(window.output),
      expected: null, failures: 0,
    };
    records.set(key, record);
    for (const signal of ["minimizedChanged", "fullScreenChanged", "desktopsChanged",
      "activitiesChanged", "maximizedChanged", "windowClassChanged", "tileChanged"]) {
      connect(window[signal], () => { if (!applying) queue(); });
    }
    connect(window.outputChanged, () => {
      if (!applying && !interaction && record.expected && sameRect(window.frameGeometry, record.expected)) queue();
    });
    connect(window.frameGeometryChanged, () => {
      // Do not reset the failure counter here: a window that fights its tile
      // briefly visits the requested geometry between refusals, which would
      // mask a persistent refusal. Stable compliance is detected by the next
      // reconciliation pass instead.
      if (!sameRect(window.frameGeometry, record.expected) && !applying && !interaction) queue();
    });
    connect(window.interactiveMoveResizeStarted, () => beginInteraction(window));
    connect(window.interactiveMoveResizeStepped, (geometry) => stepInteraction(window, geometry));
    connect(window.interactiveMoveResizeFinished, () => finishInteraction(window));
    return record;
  }
  function findRecord(id) {
    return [...records.values()].find((record) => record.id === id);
  }
  function locate(id, value = state) {
    return value?.displays.find((display) => display.windows.includes(id));
  }
  function removeWindow(value, id) {
    const display = locate(id, value);
    if (!display) return value;
    const activeDisplayId = value.activeDisplayId;
    const selected = display.activeWindowId;
    value = Engine.applyAction(value, { type: "select-window", id });
    value = Engine.applyAction(value, { type: "remove-window" });
    if (selected !== id && locate(selected, value)) value = Engine.applyAction(value, { type: "select-window", id: selected });
    if (value.displays.some((item) => item.id === activeDisplayId)) value.activeDisplayId = activeDisplayId;
    return value;
  }
  function addWindow(value, display, record) {
    const activeDisplayId = value.activeDisplayId;
    const selected = display.activeWindowId;
    value.activeDisplayId = display.id;
    value.nextWindowId = record.id;
    value = Engine.applyAction(value, { type: "add-window" });
    value.nextWindowId = nextWindowId;
    const updated = value.displays.find((item) => item.id === display.id);
    if (selected !== null && updated.windows.includes(selected)) updated.activeWindowId = selected;
    if (value.displays.some((item) => item.id === activeDisplayId)) value.activeDisplayId = activeDisplayId;
    return value;
  }
  function synchronize() {
    const key = currentKey();
    if (state) contexts.set(context, state);
    context = key;
    state = contexts.get(key) || emptyState();
    state.spreadResize = spreadResize;
    const screens = outputList();
    const live = new Map();
    for (const output of screens) {
      const name = outputName(output);
      if (!outputs.has(name)) {
        outputs.set(name, nextOutputId++);
        for (const signal of ["geometryChanged", "scaleChanged"]) connect(output[signal], queue);
      }
      const geometry = bounds(output);
      if (geometry.width <= 0 || geometry.height <= 0) continue;
      const id = outputs.get(name);
      const old = state.displays.find((display) => display.id === id);
      live.set(name, { output, display: old
        ? { ...old, ...geometry }
        : { id, ...geometry, mode: defaultMode, windows: [], activeWindowId: null } });
    }
    if (!live.size) { state = emptyState(); return; }
    const oldDisplays = state.displays;
    state.displays = [...live.values()].map((item) => item.display);
    if (!state.displays.some((display) => display.id === state.activeDisplayId)) {
      state.activeDisplayId = state.displays[0].id;
    }
    const windows = Array.from(workspace.windowList());
    const alive = new Set(windows.map(windowKey));
    const current = new Map();
    for (const window of windows) {
      if (!eligible(window)) continue;
      const record = watch(window);
      if (!record.original) record.original = snapshot(window);
      current.set(record.id, record);
    }
    for (const display of [...state.displays]) {
      for (const id of [...display.windows]) {
        if (!current.has(id)) state = removeWindow(state, id);
      }
    }
    for (const record of current.values()) {
      if (locate(record.id)) continue;
      const previousDisplay = oldDisplays.find((display) => display.windows.includes(record.id));
      const destination = live.get(record.output) || live.get(outputName(record.window.output))
        || (previousDisplay && [...live.values()].sort((a, b) => {
          const distance = (item) => (item.display.x - previousDisplay.x) ** 2 + (item.display.y - previousDisplay.y) ** 2;
          return distance(a) - distance(b);
        })[0]) || [...live.values()][0];
      state = addWindow(state, state.displays.find((display) => display.id === destination.display.id), record);
    }
    for (const [id, record] of records) if (!alive.has(id)) records.delete(id);
    state.nextWindowId = nextWindowId;
    state.nextDisplayId = nextOutputId;
    if (pendingActivation) {
      const record = records.get(pendingActivation);
      if (record && locate(record.id)) state = Engine.applyAction(state, { type: "select-window", id: record.id });
      pendingActivation = null;
    }
    contexts.set(context, state);
  }
  function tileRect(display, tile) {
    const x = Math.round(display.x + tile.x * display.width);
    const y = Math.round(display.y + tile.y * display.height);
    return {
      x, y,
      width: Math.round(display.x + (tile.x + tile.width) * display.width) - x,
      height: Math.round(display.y + (tile.y + tile.height) * display.height) - y,
    };
  }
  function fits(window, geometry) {
    const frame = window.frameGeometry;
    const client = window.clientGeometry || frame;
    const extraWidth = Math.max(0, frame.width - client.width);
    const extraHeight = Math.max(0, frame.height - client.height);
    const min = window.minSize || { width: 1, height: 1 };
    const max = window.maxSize || { width: Infinity, height: Infinity };
    return geometry.width >= min.width + extraWidth - 1 && geometry.height >= min.height + extraHeight - 1
      && geometry.width <= max.width + extraWidth + 1 && geometry.height <= max.height + extraHeight + 1;
  }
  function displayFits(display) {
    return Engine.getTiles(display).every((tile) => {
      const record = findRecord(tile.windowId);
      return record && fits(record.window, tileRect(display, tile));
    });
  }
  function constraintDetail(display) {
    return Engine.getTiles(display).map((tile) => {
      const record = findRecord(tile.windowId);
      if (!record) return "";
      const window = record.window;
      const min = window.minSize || { width: 1, height: 1 };
      const max = window.maxSize || { width: Infinity, height: Infinity };
      const target = tileRect(display, tile);
      const limits = `${Math.round(min.width)}×${Math.round(min.height)}`
        + (max.width === Infinity && max.height === Infinity ? ""
          : `–${max.width === Infinity ? "∞" : Math.round(max.width)}×${max.height === Infinity ? "∞" : Math.round(max.height)}`);
      return `"${window.caption}" needs ${limits}, tile is ${target.width}×${target.height}`;
    }).filter(Boolean).join("; ");
  }
  function fittingMode(display) {
    // Binary first: its halved cells are the most likely to satisfy wide/tall limits.
    for (const mode of ["binary", "columns", "horizontal"]) {
      if (mode === display.mode) continue;
      // A layout switch resets proportions, so candidates start from an equal layout.
      if (displayFits({ ...display, mode, layout: undefined })) return mode;
    }
    return null;
  }
  function applyGeometry() {
    if (!enabled || !state) return;
    applying = true;
    try {
      for (let index = 0; index < state.displays.length; index++) {
        let display = state.displays[index];
        if (!displayFits(display)) {
          const detail = constraintDetail(display);
          const mode = fittingMode(display);
          if (!mode) {
            report(`Cannot tile output ${display.id}: application size limits cannot fit this layout. Change layout or close a window.`, detail);
            continue;
          }
          const previousMode = display.mode;
          state = Engine.applyAction(state, { type: "set-layout", id: display.id, mode });
          contexts.set(context, state);
          display = state.displays.find((item) => item.id === display.id);
          report(`Output ${display.id} layout switched from ${previousMode} to ${mode} to fit application size limits.`, detail);
        }
        for (const tile of Engine.getTiles(display)) {
          const record = findRecord(tile.windowId);
          if (!record || record.window.deleted) continue;
          const window = record.window;
          const expected = tileRect(display, tile);
          record.output = [...outputs].find(([, id]) => id === display.id)?.[0] || record.output;
          if (sameRect(window.frameGeometry, expected) && !window.tile && !window.maximizeMode) {
            record.expected = expected;
            record.failures = 0;
            continue;
          }
          if (sameRect(record.expected, expected)) record.failures++;
          else record.failures = 0;
          record.expected = expected;
          if (record.failures > 12) {
            // A fresh layout change that a window persistently refuses is undone,
            // rather than leaving transferred windows hidden behind the refuser.
            if (pendingAction && Date.now() - pendingAction.at <= 3000 && pendingAction.context === currentKey()) {
              const snapshot = pendingAction.snapshot;
              pendingAction = null;
              state = snapshot;
              contexts.set(context, state);
              report(`Recent layout change undone: a window on output ${display.id} would not accept its new size.`);
              queue();
              return;
            }
            report(`A window on output ${display.id} is not accepting its tile size; enforcement paused for that window.`,
              `Window "${window.caption}" is not accepting its tile size (tile ${expected.width}×${expected.height}); enforcement paused for that window.`);
            continue;
          }
          if (window.tile) window.tile = null;
          if (window.maximizeMode && window.setMaximize) window.setMaximize(false, false);
          window.frameGeometry = expected;
        }
      }
    } finally { applying = false; }
  }
  function activated(window) {
    if (applying || !eligible(window) || !state) return;
    const record = records.get(windowKey(window));
    if (record && locate(record.id)) {
      state = Engine.applyAction(state, { type: "select-window", id: record.id });
    } else {
      pendingActivation = windowKey(window);
      queue();
    }
  }
  function reconcile() {
    if (!enabled) return;
    synchronize();
    // Keep explicit empty-output selection: synchronization must not focus elsewhere.
    applyGeometry();
  }
  function focusSelected() {
    const display = state && Engine.getActiveDisplay(state);
    const record = display && findRecord(display.activeWindowId);
    if (!record || !eligible(record.window)) return;
    applying = true;
    try {
      workspace.activeWindow = record.window;
      if (workspace.raiseWindow) workspace.raiseWindow(record.window);
    } finally { applying = false; }
  }
  function perform(action) {
    if (action.type === "pause") { enabled = !enabled; pendingAction = null; if (enabled) reconcile(); return; }
    if (action.type === "restore") { pendingAction = null; restore(); return; }
    if (!enabled || interaction) return;
    reconcile();
    if (!state.displays.length) return;
    if (action.type === "select-monitor") {
      const display = state.displays[action.index];
      if (!display) return;
      action = { type: "select-display", id: display.id };
    }
    if (action.type === "toggle-spread") action = { type: "set-spread-resize", enabled: !spreadResize };
    if (!["focus", "move", "rotate", "set-layout", "select-display", "select-window", "set-spread-resize"].includes(action.type)) return;
    if (action.type === "move") {
      // Pre-flight: never commit a transfer or swap whose destination no layout
      // can satisfy. Committing it would move windows logically while the
      // applications stay where they were, hiding the true desktop state.
      const next = Engine.applyAction(state, action);
      const impossible = next.displays.find((after) => {
        const before = state.displays.find((item) => item.id === after.id);
        return (!before || before.windows.join(",") !== after.windows.join(","))
          && !displayFits(after) && !fittingMode(after);
      });
      if (impossible) {
        report("Cannot complete that move: application size limits cannot fit the destination layout.",
          constraintDetail(impossible));
        return;
      }
    }
    const snapshot = ["move", "rotate", "set-layout"].includes(action.type) ? copy(state) : null;
    state = Engine.applyAction(state, action);
    pendingAction = snapshot ? { snapshot, at: Date.now(), context } : null;
    spreadResize = state.spreadResize;
    contexts.set(context, state);
    applyGeometry();
    focusSelected();
  }
  function beginInteraction(window) {
    if (!enabled || !state) return;
    const record = records.get(windowKey(window));
    const display = record && locate(record.id);
    if (!display) return;
    state = Engine.applyAction(state, { type: "select-window", id: record.id });
    const tile = Engine.getTiles(display).find((item) => item.windowId === record.id);
    interaction = {
      id: record.id, original: tileRect(display, tile), state: copy(state),
      displayId: display.id, resizing: window.resize, context,
    };
  }
  function stepInteraction(window, requested) {
    if (!enabled || applying || !interaction || windowKey(window) !== windowKey(findRecord(interaction.id)?.window || {})) return;
    if (interaction.context !== currentKey()) { interaction = null; queue(); return; }
    if (!interaction.resizing) { applyGeometry(); return; }
    const original = interaction.original;
    const display = interaction.state.displays.find((item) => item.id === interaction.displayId);
    const tile = Engine.getTiles(display).find((item) => item.windowId === interaction.id);
    const movements = [
      { axis: "x", edge: "left", delta: requested.x - original.x, position: tile.x },
      { axis: "x", edge: "right", delta: requested.x + requested.width - original.x - original.width, position: tile.x + tile.width },
      { axis: "y", edge: "top", delta: requested.y - original.y, position: tile.y },
      { axis: "y", edge: "bottom", delta: requested.y + requested.height - original.y - original.height, position: tile.y + tile.height },
    ];
    const actions = [];
    for (const axis of ["x", "y"]) {
      const movement = movements.filter((item) => item.axis === axis).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      if (Math.abs(movement.delta) < 0.5) continue;
      const boundary = Engine.getBoundaries(display).filter((item) => item.axis === axis
        && Math.abs(item.position - movement.position) < 1e-6
        && (axis === "x"
          ? item.y < tile.y + tile.height - 1e-6 && item.y + item.height > tile.y + 1e-6
          : item.x < tile.x + tile.width - 1e-6 && item.x + item.width > tile.x + 1e-6))
        .sort((a, b) => b.extent - a.extent)[0];
      if (!boundary) continue; // Outside edges are fixed.
      actions.push({
        type: "resize-boundary", id: display.id, boundaryId: boundary.id,
        anchorWindowId: display.mode === "binary" ? undefined : interaction.id,
        start: boundary.position,
        delta: movement.delta / (axis === "x" ? display.width : display.height),
      });
    }
    const proposal = (factor) => {
      let value = interaction.state;
      for (const action of actions) value = Engine.applyAction(value, {
        ...action, position: action.start + action.delta * factor,
      });
      return value;
    };
    let next = proposal(1);
    if (!displayFits(next.displays.find((item) => item.id === display.id))) {
      let low = 0;
      let high = 1;
      for (let i = 0; i < 14; i++) {
        const middle = (low + high) / 2;
        if (displayFits(proposal(middle).displays.find((item) => item.id === display.id))) low = middle;
        else high = middle;
      }
      next = proposal(low);
    }
    state = next;
    contexts.set(context, state);
    applyGeometry();
  }
  function finishInteraction(window) {
    if (!interaction) return;
    interaction = null;
    applyGeometry();
    queue();
  }
  function restore() {
    enabled = false;
    interaction = null;
    applying = true;
    try {
      for (const record of records.values()) {
        if (!record.original || record.window.deleted) continue;
        try {
          const window = record.window;
          window.tile = null;
          if (window.setMaximize) window.setMaximize(false, false);
          const available = outputList();
          let geometry = { ...record.original.geometry };
          if (available.length && !available.some((output) => {
            const area = bounds(output);
            return geometry.x < area.x + area.width && geometry.x + geometry.width > area.x
              && geometry.y < area.y + area.height && geometry.y + geometry.height > area.y;
          })) geometry = { ...geometry, x: bounds(available[0]).x, y: bounds(available[0]).y };
          window.frameGeometry = geometry;
          if (record.original.tile) window.tile = record.original.tile;
          else if (record.original.maximizeMode && window.setMaximize) {
            window.setMaximize(Boolean(record.original.maximizeMode & 1), Boolean(record.original.maximizeMode & 2));
          }
        } catch (error) { log(`Could not restore a window: ${error}`); }
      }
    } finally { applying = false; }
  }
  connect(workspace.windowAdded, (window) => { watch(window); queue(); });
  connect(workspace.windowRemoved, () => { interaction = null; queue(); });
  connect(workspace.windowActivated, activated);
  for (const signal of ["screensChanged", "screenOrderChanged", "virtualScreenGeometryChanged",
    "currentDesktopChanged", "currentActivityChanged"]) connect(workspace[signal], () => { interaction = null; queue(); });
  reconcile();
  activated(workspace.activeWindow);
  return {
    perform, reconcile, beginInteraction, stepInteraction, finishInteraction, restore,
    getState: () => copy(state), isEnabled: () => enabled,
    diagnostics: () => ({ enabled, context, warnings: [...warnings], interacting: Boolean(interaction) }),
    inspect: () => [...records.values()].map((record) => ({
      id: record.id, caption: record.window.caption, geometry: rect(record.window.frameGeometry),
      active: record.window.active, minimized: record.window.minimized, output: outputName(record.window.output),
      resizing: record.window.resize,
    })),
  };
}
