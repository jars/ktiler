import * as Engine from "../engine.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const rect = (value) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
const sameRect = (a, b) => a && b && ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= 0.1);
const outputName = (output) => String(output?.name ?? "");
const windowKey = (window) => String(window.internalId);

export function createController(host) {
  const { workspace, defer, log = () => {}, config = () => undefined, debug = false, feedback = null } = host;
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
  let restoringMove = null;
  let pendingActivation = null;
  let lastFeedback = null;
  let spreadResize = config("SpreadResize", true) !== false;
  const warnings = new Set();

  function report(safe, detail) {
    // Default diagnostics never contain window titles or other user content;
    // debug mode appends the detail (titles and size limits).
    const text = debug && detail ? `${safe} Debug detail: ${detail}` : safe;
    if (warnings.has(text)) return;
    warnings.add(text);
    log(text);
  }
  function showRejection(reason) {
    if (!feedback) return;
    const at = Date.now();
    if (lastFeedback?.reason === reason && at - lastFeedback.at < 500) return;
    lastFeedback = { reason, at };
    try { feedback(reason); } catch (error) { /* Feedback must never disturb tiling. */ }
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
  function isMaximized(window) {
    return Boolean(window && (Number(window.maximizeMode) || records.get(windowKey(window))?.requestedMaximizeMode));
  }
  function onCurrentWorkspace(window) {
    const desktops = window.desktops || [];
    const activities = window.activities || [];
    return (window.onAllDesktops || !desktops.length || desktops.some((desktop) => desktop.id === workspace.currentDesktop?.id))
      && (!activities.length || activities.includes(workspace.currentActivity));
  }
  function eligible(window, { includeMaximized = false } = {}) {
    return window && !window.deleted && window.managed !== false && window.normalWindow
      && !window.dialog && !window.transient && !window.specialWindow && window.resizeable
      && window.moveable && !window.minimized && !window.fullScreen
      && (includeMaximized || !isMaximized(window)) && onCurrentWorkspace(window);
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
    return { geometry: rect(window.frameGeometry), tile: window.tile };
  }
  function maximizationChanged(record) {
    if (isMaximized(record.window)) record.rejoinOnCurrentOutput = true;
    if (record.rejoinOnCurrentOutput) {
      // Neither a drag baseline nor an undo snapshot can survive a membership change.
      interaction = null;
      pendingAction = null;
      record.expected = null;
      record.failures = 0;
    }
    queue();
  }
  function watch(window) {
    const key = windowKey(window);
    if (records.has(key)) return records.get(key);
    const record = {
      id: nextWindowId++, window, original: null, output: outputName(window.output),
      expected: null, failures: 0, requestedMaximizeMode: 0, rejoinOnCurrentOutput: false,
    };
    records.set(key, record);
    for (const signal of ["minimizedChanged", "fullScreenChanged", "desktopsChanged",
      "activitiesChanged", "maximizeableChanged", "windowClassChanged", "tileChanged"]) {
      connect(window[signal], () => { if (!applying) queue(); });
    }
    connect(window.maximizedAboutToChange, (mode) => {
      // On Wayland the current mode doesn't change until the client commits.
      const requested = Number(mode);
      if (!Number.isFinite(requested)) return;
      record.requestedMaximizeMode = requested;
      maximizationChanged(record);
    });
    connect(window.maximizedChanged, () => {
      if (Number(window.maximizeMode) === record.requestedMaximizeMode) record.requestedMaximizeMode = 0;
      maximizationChanged(record);
    });
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
      // Watch existing maximized windows too, so their first unmaximize is seen.
      if (window.deleted || !window.normalWindow) continue;
      const record = watch(window);
      if (isMaximized(window)) record.rejoinOnCurrentOutput = true;
      if (record === restoringMove?.record || !eligible(window)) continue;
      if (!record.original) record.original = snapshot(window);
      current.set(record.id, record);
    }
    for (const display of [...state.displays]) {
      for (const id of [...display.windows]) {
        if (!current.has(id)) state = removeWindow(state, id);
      }
    }
    for (const record of current.values()) {
      const placed = locate(record.id);
      const returning = record.rejoinOnCurrentOutput;
      if (placed && !returning) continue;
      const actual = live.get(outputName(record.window.output));
      if (!placed || (actual && actual.display.id !== placed.id)) {
        if (placed) state = removeWindow(state, record.id);
        const previousDisplay = oldDisplays.find((display) => display.windows.includes(record.id));
        const destination = (returning && actual) || live.get(record.output) || actual
          || (previousDisplay && [...live.values()].sort((a, b) => {
            const distance = (item) => (item.display.x - previousDisplay.x) ** 2 + (item.display.y - previousDisplay.y) ** 2;
            return distance(a) - distance(b);
          })[0]) || [...live.values()][0];
        state = addWindow(state, state.displays.find((display) => display.id === destination.display.id), record);
      }
      if (returning) {
        record.rejoinOnCurrentOutput = false;
        if (actual) record.output = outputName(actual.output);
        if (record.window.active) pendingActivation = windowKey(record.window);
      }
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
  const tileRect = Engine.tilePixels;
  function frameLimits(window) {
    const frame = window.frameGeometry;
    const client = window.clientGeometry || frame;
    const extraWidth = Math.max(0, frame.width - client.width);
    const extraHeight = Math.max(0, frame.height - client.height);
    const min = window.minSize || { width: 1, height: 1 };
    const max = window.maxSize || { width: Infinity, height: Infinity };
    return {
      minWidth: Math.max(1, Math.ceil(min.width + extraWidth - 1e-6)),
      minHeight: Math.max(1, Math.ceil(min.height + extraHeight - 1e-6)),
      maxWidth: Math.floor(max.width + extraWidth + 1e-6),
      maxHeight: Math.floor(max.height + extraHeight + 1e-6),
    };
  }
  function displayLimits(display) {
    return new Map(display.windows.map((id) => [id, frameLimits(findRecord(id).window)]));
  }
  function resolvedDisplay(display) {
    return Engine.fitDisplay(display, displayLimits(display)) || display;
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
  function fittingLayout(display) {
    const limits = displayLimits(display);
    const current = Engine.fitDisplay(display, limits);
    if (current) return current;
    for (const mode of ["binary", "columns", "horizontal"]) {
      if (mode === display.mode) continue;
      const candidate = Engine.fitDisplay({ ...display, mode, layout: undefined }, limits);
      if (candidate) return candidate;
    }
    return null;
  }
  function checkMove(next) {
    // Include every changed output, including any window that will be restored.
    const impossible = next.displays.find((after) => {
      const before = state.displays.find((item) => item.id === after.id);
      return (!before || before.windows.join(",") !== after.windows.join(",")) && !fittingLayout(after);
    });
    if (!impossible) return true;
    report("Cannot complete that move: application size limits cannot fit the destination layout.",
      constraintDetail(impossible));
    showRejection("ktiler: move blocked because a window has dimension constraints.");
    return false;
  }
  function restoreMaximization(move) {
    if (!move || move.record.window.deleted) return;
    move.record.window.setMaximize(Boolean(move.mode & 1), Boolean(move.mode & 2));
  }
  function cancelRestoringMove() {
    const move = restoringMove;
    if (!move) return;
    restoringMove = null;
    restoreMaximization(move);
    queue();
  }
  function applyGeometry(visibleDrag = null) {
    if (!enabled || !state) return;
    applying = true;
    try {
      for (const preferred of state.displays) {
        const display = visibleDrag?.id === preferred.id ? visibleDrag : fittingLayout(preferred);
        if (!display) {
          report(`Cannot tile output ${preferred.id}: application size limits cannot fit this layout. Change layout or close a window.`,
            constraintDetail(preferred));
          continue;
        }
        if (display.mode !== preferred.mode) {
          state = Engine.applyAction(state, { type: "set-layout", id: display.id, mode: display.mode });
          contexts.set(context, state);
          report(`Output ${display.id} layout switched from ${preferred.mode} to ${display.mode} to fit application size limits.`,
            constraintDetail(preferred));
        }
        for (const tile of Engine.getTiles(display)) {
          const record = findRecord(tile.windowId);
          if (!eligible(record?.window)) continue;
          const window = record.window;
          const expected = tileRect(display, tile);
          record.output = [...outputs].find(([, id]) => id === display.id)?.[0] || record.output;
          if (sameRect(window.frameGeometry, expected) && !window.tile) {
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
              const { snapshot, type, restored } = pendingAction;
              pendingAction = null;
              state = snapshot;
              contexts.set(context, state);
              restoreMaximization(restored);
              report(`Recent layout change undone: a window on output ${display.id} would not accept its new size.`);
              if (type === "move") showRejection("Move undone: a window didn't accept its new size.");
              queue();
              return;
            }
            report(`A window on output ${display.id} is not accepting its tile size; enforcement paused for that window.`,
              `Window "${window.caption}" is not accepting its tile size (tile ${expected.width}×${expected.height}); enforcement paused for that window.`);
            continue;
          }
          if (window.tile) window.tile = null;
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
    if (restoringMove) {
      finishRestoringMove();
      return;
    }
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
  function moveMaximized(window, direction) {
    if (window.deleted || window.fullScreen || !workspace.sendClientToScreen) return;
    const sides = { left: "to the left", right: "to the right", up: "above", down: "below" };
    if (!Object.prototype.hasOwnProperty.call(sides, direction)) return;
    const displays = outputList().map((output, id) => ({ ...bounds(output), id, output }))
      .filter(({ width, height }) => width > 0 && height > 0);
    const source = displays.find(({ output }) => outputName(output) === outputName(window.output));
    if (!source) return;
    const destination = Engine.neighboringDisplay(displays, source, direction);
    if (!destination) {
      showRejection(`ktiler: no monitor ${sides[direction]}.`);
      return;
    }
    // Let KWin transfer the maximize state and restore geometry together.
    workspace.sendClientToScreen(window, destination.output);
  }
  function visibleMaximizedOn(display) {
    // A normal or fullscreen window takes precedence over one behind it.
    const front = Array.from(workspace.stackingOrder || []).reverse().find((window) =>
      window && !window.deleted && !window.minimized && !window.hidden
      && (window.normalWindow || window.fullScreen)
      && outputs.get(outputName(window.output)) === display.id && onCurrentWorkspace(window));
    if (!eligible(front, { includeMaximized: true }) || !front.setMaximize) return null;
    const mode = Number(front?.maximizeMode);
    const record = mode && records.get(windowKey(front));
    return record ? { record, mode } : null;
  }
  function finishRestoringMove() {
    const move = restoringMove;
    const { record } = move;
    const active = workspace.activeWindow;
    if (context !== move.context || !active || records.get(windowKey(active))?.id !== move.incoming
      || !eligible(record.window, { includeMaximized: true })
      || outputs.get(outputName(record.window.output)) !== move.destination) {
      cancelRestoringMove();
      return;
    }
    if (isMaximized(record.window)) {
      // Wait for the Wayland client to commit the restore, but don't hold a
      // move open indefinitely if a window or rule refuses it.
      if (++move.checks < 60) queue();
      else {
        cancelRestoringMove();
        showRejection("Move undone: a window didn't accept its new size.");
      }
      return;
    }
    const next = Engine.applyAction(state, move.action, resolvedDisplay);
    const destination = Engine.getActiveDisplay(next);
    if (next.activeDisplayId === state.activeDisplayId || destination?.id !== move.destination
      || destination.activeWindowId !== move.incoming) {
      cancelRestoringMove();
      return;
    }
    // A restored decoration can change frame limits; recheck before moving
    // the incoming window or touching the live tiling layout.
    const proposed = addWindow(next, destination, record);
    if (!checkMove(proposed)) {
      cancelRestoringMove();
      return;
    }
    restoringMove = null;
    record.rejoinOnCurrentOutput = false;
    if (!record.original) record.original = snapshot(record.window);
    commitAction(proposed, "move", move);
  }
  function commitAction(next, type, restored = null) {
    const snapshot = ["move", "rotate", "set-layout"].includes(type) ? copy(state) : null;
    state = next;
    pendingAction = snapshot ? { snapshot, type, at: Date.now(), context, restored } : null;
    spreadResize = state.spreadResize;
    contexts.set(context, state);
    applyGeometry();
    focusSelected();
  }
  function perform(action) {
    if (action.type === "pause") {
      cancelRestoringMove();
      enabled = !enabled;
      pendingAction = null;
      if (enabled) reconcile();
      return;
    }
    if (action.type === "restore") { pendingAction = null; restore(); return; }
    if (!enabled || interaction || restoringMove) return;
    if (action.type === "move" && isMaximized(workspace.activeWindow)) {
      moveMaximized(workspace.activeWindow, action.direction);
      return;
    }
    reconcile();
    if (!state.displays.length) return;
    if (action.type === "toggle-spread") action = { type: "set-spread-resize", enabled: !spreadResize };
    if (!["focus", "move", "rotate", "set-layout", "select-display", "select-window", "set-spread-resize"].includes(action.type)) return;
    const next = Engine.applyAction(state, action, resolvedDisplay);
    if (action.type === "move") {
      const destination = Engine.getActiveDisplay(next);
      const visible = destination.id !== state.activeDisplayId && visibleMaximizedOn(destination);
      if (visible) {
        if (!checkMove(addWindow(next, destination, visible.record))) return;
        restoringMove = { ...visible, action, destination: destination.id, context,
          incoming: destination.activeWindowId, checks: 0 };
        pendingAction = null;
        visible.record.window.setMaximize(false, false);
        queue();
        return;
      }
      if (!checkMove(next)) return;
    }
    commitAction(next, action.type);
  }
  function beginInteraction(window) {
    if (!enabled || !state || !eligible(window)) return;
    if (restoringMove) cancelRestoringMove();
    const record = records.get(windowKey(window));
    const display = record && locate(record.id);
    if (!display) return;
    state = Engine.applyAction(state, { type: "select-window", id: record.id });
    const preferred = state.displays.find((item) => item.id === display.id);
    const visible = fittingLayout(preferred);
    if (!visible || visible.mode !== preferred.mode) return;
    const tile = Engine.getTiles(visible).find((item) => item.windowId === record.id);
    interaction = {
      id: record.id, original: tileRect(visible, tile), visible, preferred, state: copy(state),
      resizing: window.resize, context,
    };
  }
  function stepInteraction(window, requested) {
    if (!enabled || applying || !interaction || windowKey(window) !== windowKey(findRecord(interaction.id)?.window || {})) return;
    if (interaction.context !== currentKey()) { interaction = null; queue(); return; }
    if (!interaction.resizing) { applyGeometry(); return; }
    const original = interaction.original;
    const display = interaction.visible;
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
      let value = { ...interaction.state,
        displays: interaction.state.displays.map((item) => item.id === display.id ? display : item) };
      for (const action of actions) value = Engine.applyAction(value, {
        ...action, position: action.start + action.delta * factor,
      });
      return value.displays.find((item) => item.id === display.id);
    };
    const limits = displayLimits(display);
    let next = proposal(1);
    if (!Engine.layoutFits(next, limits)) {
      if (!Engine.layoutFits(display, limits)) { applyGeometry(); return; }
      let low = 0;
      let high = 1;
      for (let i = 0; i < 14; i++) {
        const middle = (low + high) / 2;
        if (Engine.layoutFits(proposal(middle), limits)) low = middle;
        else high = middle;
      }
      next = proposal(low);
    }
    const preferred = Engine.preferResizedSplits(interaction.preferred, display, next);
    state = { ...state, displays: state.displays.map((item) => item.id === display.id ? preferred : item) };
    contexts.set(context, state);
    applyGeometry(next);
  }
  function finishInteraction(window) {
    if (!interaction) return;
    interaction = null;
    applyGeometry();
    queue();
  }
  function restore() {
    enabled = false;
    cancelRestoringMove();
    interaction = null;
    applying = true;
    try {
      for (const record of records.values()) {
        if (!record.original || record.window.deleted || isMaximized(record.window)) continue;
        try {
          const window = record.window;
          window.tile = null;
          const available = outputList();
          let geometry = { ...record.original.geometry };
          if (available.length && !available.some((output) => {
            const area = bounds(output);
            return geometry.x < area.x + area.width && geometry.x + geometry.width > area.x
              && geometry.y < area.y + area.height && geometry.y + geometry.height > area.y;
          })) geometry = { ...geometry, x: bounds(available[0]).x, y: bounds(available[0]).y };
          window.frameGeometry = geometry;
          if (record.original.tile) window.tile = record.original.tile;
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
    getEffectiveState: () => copy({ ...state, displays: state.displays.map(resolvedDisplay) }),
    diagnostics: () => ({ enabled, context, warnings: [...warnings], interacting: Boolean(interaction) }),
    inspect: () => [...records.values()].map((record) => ({
      id: record.id, caption: record.window.caption, geometry: rect(record.window.frameGeometry),
      active: record.window.active, minimized: record.window.minimized, output: outputName(record.window.output),
      resizing: record.window.resize, maximizeMode: Number(record.window.maximizeMode) || 0,
    })),
  };
}
