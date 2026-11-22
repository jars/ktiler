// The tile is the window. These app interiors are decorative; only the tile is interactive.
const bars = (...widths) => widths.map((width) => `<span class="app-line" style="width:${width}%"></span>`).join("");
const cells = (...labels) => labels.map((label) => `<span>${label}</span>`).join("");
const browserIcon = (path, className = "browser-tab-icon") => `
  <svg class="${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

const apps = [
  {
    key: "terminal",
    name: "Terminal",
    icon: '<path d="m2 4 4 4-4 4m7 0h5"/>',
    body: `
      <span class="terminal-log">
        <span><b>❯</b> pwd</span><span>~/<strong>ktiler</strong></span>
        <span><b>❯</b> ls</span><span>app.js &nbsp; engine.js</span>
        <span><b>❯</b> <span class="app-caret terminal-cursor"></span></span>
      </span>`,
  },
  {
    key: "code",
    name: "Code Editor",
    icon: '<path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14"/>',
    body: `
      <span class="app-rail code-tree">
        <b>▾ ktiler</b><span>app.js</span><span class="app-current">engine.js</span><span>style.css</span>
      </span>
      <span class="app-main">
        <span class="app-bar"><span class="app-tab">engine.js</span></span>
        <span class="code-source">
          <span><i>1</i><b>function</b> tile() {</span>
          <span><i>2</i>&nbsp; <b>return</b> layout;<span class="app-caret code-cursor"></span></span>
          <span><i>3</i>}</span>
        </span>
      </span>`,
  },
  {
    key: "browser",
    name: "Chrome",
    icon: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/>',
    body: `
      <span class="browser-tabs">
        <span class="browser-tab browser-tab-active">
          <img class="browser-tab-icon" src="/ktiler-icon.png" width="10" height="10" alt="">
          <span class="browser-tab-label">ktiler<span class="browser-tab-context"> — KDE Plasma</span></span>
          ${browserIcon("m4 4 8 8m0-8-8 8", "browser-tab-close")}
        </span>
        <span class="browser-tab">
          ${browserIcon("M3 5h10l1 9H2zM5.5 6V4a2.5 2.5 0 0 1 5 0v2")}
          <span class="browser-tab-label">Window Shopping</span>
        </span>
        <span class="browser-tab">
          ${browserIcon("m3 4 4 4-4 4m6 0h4")}
          <span class="browser-tab-label">How to Exit Vim</span>
        </span>
        ${browserIcon("M8 3v10M3 8h10", "browser-tab-add")}
      </span>
      <span class="app-bar browser-toolbar"><span>‹ &nbsp;›</span><strong class="browser-address">https://ktiler.org</strong></span>
      <span class="browser-page">
        <span class="browser-home">
          <span class="browser-home-header">
            <img src="/ktiler-logo-w-text.png" alt="" width="568" height="232">
            <span class="browser-home-nav"><b>Home</b><span>Install</span><span>Simulator</span><span>Help</span><span>GitHub</span></span>
          </span>
          <span class="browser-home-hero">
            <span class="browser-home-copy">
              <b class="browser-home-title">Automatic window tiling for KDE Plasma</b>
              <span class="browser-home-tagline">Make room for what’s next.</span>
              <span class="browser-home-install">Install <b>ktiler</b></span>
            </span>
            <svg class="browser-home-monitors" viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
              <g fill="#1b1e23">
                <rect x="2" y="2" width="124" height="60" rx="2"/>
                <rect x="2" y="66" width="124" height="60" rx="2"/>
              </g>
              <path fill="var(--preview-code)" d="M5 5h59v49H5z"/>
              <path fill="var(--preview-terminal)" d="M64 5h59v49H64z"/>
              <path fill="var(--preview-image)" d="M5 69h59v49H5z"/>
              <path fill="var(--app-paper)" d="M64 69h59v49H64z"/>
              <path fill="#c9ddc8" d="M5 5h15v49H5z"/>
              <path fill="var(--app-pane)" d="M64 69h59v17H64z"/>
              <path fill="#cf984c" d="m5 109 19-23 14 14 8-8 18 17v9H5z"/>
              <path fill="none" stroke="#284438" d="M24 11h22m-20 4h25m-27 4h12"/>
              <path fill="none" stroke="#d9b5ea" d="m69 10 2 2-2 2m5-2h12m-17 6 2 2-2 2m5-2h18"/>
              <path fill="none" stroke="#a7c3de" d="M6 58h13m-13 64h13"/>
            </svg>
          </span>
        </span>
      </span>`,
  },
  {
    key: "solitaire",
    name: "Solitaire",
    icon: '<rect x="5" y="4" width="8" height="10" rx="1.5"/><path d="m2 11-1-8 8-2m0 6 2 2-2 2-2-2z"/>',
    body: `
      <span class="card-row card-deal">
        <span class="playing-card card-back">◇</span><span class="playing-card">A &spades;</span><span></span>
        <span class="card-slot"></span><span class="card-slot"></span><span class="card-slot"></span><span class="card-slot"></span>
      </span>
      <span class="card-row">${["K &diams;", "8 &clubs;", "J &spades;", "4 &hearts;", "7 &clubs;", "Q &hearts;", "5 &spades;"]
        .map((card) => `<span class="playing-card">${card}</span>`).join("")}</span>`,
  },
  {
    key: "sheet",
    name: "Spreadsheet",
    icon: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 6h12M2 10h12M6 6v8m4-8v8"/>',
    body: `
      <span class="app-bar sheet-formula"><b>B2</b><i>ƒx</i><span>=SUM(4, 8)</span></span>
      <span class="sheet-grid">
        <span class="sheet-row sheet-head">${cells("", "A", "B", "C", "D")}</span>
        <span class="sheet-row">${cells(1, "Plan", 8, 11, 19)}</span>
        <span class="sheet-row">${cells(2, "Draft", 12, 17, 29)}</span>
        <span class="sheet-row">${cells(3, "Review", 6, 15, 21)}</span>
        <span class="sheet-row">${cells(4, "", "", "", "")}</span>
      </span>`,
  },
  {
    key: "image",
    name: "Image Editor",
    icon: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="m2 11 4-4 3 3 2-2 3 3"/><circle cx="10.5" cy="5.5" r=".6"/>',
    body: `
      <span class="app-rail image-tools"><span>⌖</span><span>╱</span><span>□</span><span>+</span></span>
      <span class="app-main">
        <span class="app-bar"><span class="app-tab">ridge.svg</span></span>
        <span class="image-canvas">
          <svg viewBox="0 0 120 80" preserveAspectRatio="xMidYMid meet">
            <rect class="image-artboard" width="120" height="80"/>
            <path class="image-ridge" d="M0 64 31 29l27 27 17-17 45 27v14H0Z"/>
            <g class="image-highlight">
              <path d="m22 39 9-10 11 11-10-5z"/>
              <circle cx="87" cy="22" r="8"/>
            </g>
            <g class="image-guides" fill="none">
              <path d="M60 9.6v60.8M14.4 40h91.2"/>
              <rect x="14.4" y="9.6" width="91.2" height="60.8"/>
            </g>
          </svg>
        </span>
      </span>`,
  },
  {
    key: "files",
    name: "File Manager",
    icon: '<path d="M2 4h5l2 2h5v7H2z"/>',
    body: `
      <span class="app-bar files-path"><span>‹</span><span>Home / <strong>ktiler</strong></span></span>
      <span class="files-body">
        <span class="app-rail files-tree"><span class="app-current">Home</span><span>Recent</span><span>Projects</span></span>
        <span class="file-grid">${["Assets", "Docs", "Tests", "Layouts", "Themes", "Notes"]
          .map((name) => `<span><svg viewBox="0 0 16 16"><path d="M2 4h5l2 2h5v7H2z"/></svg>${name}</span>`).join("")}</span>
      </span>`,
  },
  {
    key: "notes",
    name: "Notes",
    icon: '<path d="M3 2h7l3 3v9H3zm7 0v4h3M6 8h4m-4 3h4"/>',
    body: `
      <span class="notes-page"><b>Layout ideas</b>${bars(89, 66, 76, 45, 84, 59)}</span>`,
  },
  {
    key: "music",
    name: "Music Player",
    icon: '<path d="M6 11V4l7-2v8M6 11c0 2-4 3-4 1s4-3 4-1zm7-1c0 2-4 3-4 1s4-3 4-1z"/>',
    body: `
      <span class="music-track">
        <span class="music-turntable">
          <span class="music-record"><img src="/kde-icon.png" alt="" draggable="false"></span>
          <svg class="music-tonearm" viewBox="0 0 100 78" fill="none">
            <circle cx="84" cy="22" r="6" fill="#a2b9d1" stroke="#547294" stroke-width="1.4"/>
            <path d="M84 22v18q0 7-6 12L64 58" stroke="#4a6483" stroke-width="2.4" stroke-linecap="round"/>
            <path d="m64 55 2 4-7 4-2-4z" fill="#344c68"/>
            <circle cx="85" cy="64" r="2" fill="#547294"/>
          </svg>
        </span>
        <span class="music-name"><b>Blue Hour</b><span>Instrumental</span></span>
        <span class="music-wave">${[25, 60, 37, 84, 100, 65, 82, 33, 68, 95, 60, 30, 66, 36, 56, 21]
           .map((height, index) => `<span style="height:${height}%;--beat:${530 + (index * 137) % 501}ms;--beat-phase:${index * 113}ms"></span>`).join("")}</span>
      </span>
      <span class="app-bar music-controls"><span>◂ &nbsp; Ⅱ &nbsp; ▸</span>
        <span class="music-progress"><span class="music-playhead"></span></span>
      </span>`,
  },
  {
    key: "calendar",
    name: "Calendar",
    icon: '<rect x="2" y="4" width="12" height="10" rx="1"/><path d="M5 2v4m6-4v4M2 8h12m-8 3h1m3 0h1"/>',
    body: `
      <span class="app-bar calendar-bar"><b>June 2026</b><span>‹ &nbsp;›</span></span>
      <span class="calendar-days">${cells("M", "T", "W", "T", "F", "S", "S")}
        ${Array.from({ length: 30 }, (_, index) =>
          `<span${index === 17 ? ' class="app-current"' : ""}>${index + 1}</span>`).join("")}
      </span>`,
  },
];

const getApp = (id) => apps[(id - 1) % apps.length];

export function getDemoWindowId(kind) {
  const index = apps.findIndex(({ key }) => key === kind);
  if (index < 0) throw new Error(`Unknown demo app: ${kind}`);
  return index + 1;
}

export function describeWindow(id) {
  // Positions and displays may change; the same ID keeps its app and title.
  const instance = Math.floor((id - 1) / apps.length) + 1;
  const { key, name } = getApp(id);
  return { kind: key, title: instance === 1 ? name : `${name} ${instance}` };
}

const templates = new Map();
const playbackStart = performance.now();

export function populateWindow(button, id) {
  const { kind, title } = describeWindow(id);
  let template = templates.get(kind);
  if (!template) {
    const { icon, body } = getApp(id);
    template = document.createElement("template");
    template.innerHTML = `
      <span class="app-ui" aria-hidden="true">${body}</span>
      <span class="app-compact" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"
             stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
        <span class="app-name"></span>
      </span>`;
    templates.set(kind, template);
  }
  const content = template.content.cloneNode(true);
  content.querySelector(".app-name").textContent = title;
  button.dataset.app = kind;
  if (kind === "music") {
    // Give tiles created at different times the same playback clock.
    button.style.setProperty("--music-delay", `${playbackStart - performance.now()}ms`);
  }
  button.setAttribute("aria-label", title);
  button.title = title;
  button.append(content);
}
