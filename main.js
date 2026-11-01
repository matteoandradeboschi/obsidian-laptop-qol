const { Plugin, PluginSettingTab, MarkdownRenderer, Component, TFile, setIcon, Notice } = require("obsidian");

// Laptop QoL: each sub-plugin is a Component loaded/unloaded by its toggle in the settings.
// New sub-plugin = one Component class + one entry in MODULES.

// ===== Swipe Nav =====
const SMOOTH = 0.30 - 4 * 0.022; // "smoothness 4" from the mockup
const DEAD = 40;                 // anti-accident dead zone (px): nothing moves before this
const RELEASE_MS = 110;          // no events for X ms = released
const COMMIT = 0.4;              // released with the other note covering ≥ 20% of the screen (x=2 ⇒ 100%) ⇒ navigate
const GAP_MS = 80;               // pause between events = new fingers (end of the previous gesture's inertia)
const LOCK_MS = 300;             // vertical scroll less than X ms ago ⇒ horizontal doesn't start a gesture
const NO_SWIPE = ["excalidraw", "graph", "localgraph", "canvas"]; // views with their own pan
const RATIO = 3;                // to start: |dx| > RATIO·|dy| (~18° from horizontal), per event and accumulated in the dead zone
// E-Ink theme: instant switch, no drag
const INK_THEME = /^E-Ink\b/i; // E-Ink, E-Ink 2, E-ink
const INK_STEP = 60;             // accumulated px ⇒ navigate immediately
const INK_QUIET = 120;           // after navigating, swallow the gesture until X ms without events

class SwipeNav extends Component {
  constructor(plugin, settings) {
    super();
    this.app = plugin.app;
    this.settings = settings;
  }

  onload() {
    this.g = null;
    this.inertia = false; // true after navigating: swallow the rest of the drag/inertia until a pause or reversal
    this.lastT = 0;
    this.lastDx = 0;
    this.vT = 0; // last vertical scroll (axis lock)
    this.registerDomEvent(window, "wheel", (e) => this.onWheel(e), { passive: false, capture: true });
    this.ink = { leaf: null, acc: 0, t: 0, swallow: false };
  }

  onunload() {
    if (this.g) this.cleanup();
  }

  eink() {
    return !!this.app.customCss && INK_THEME.test(this.app.customCss.theme);
  }

  // E-Ink: note stays still, no indicator; past INK_STEP ⇒ back/forward and ignore inertia
  onWheelInk(e) {
    const s = this.ink, now = performance.now();
    if (s.swallow) {
      if (now - s.t < INK_QUIET) { s.t = now; if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault(); return; }
      s.swallow = false;
    }
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) {
      if (s.leaf && now - s.t <= GAP_MS) e.preventDefault();
      else if (e.deltaY) this.vT = now;
      return;
    }
    const dx = (this.settings.invert ? 1 : -1) * e.deltaX * (e.deltaMode === 1 ? 16 : 1);
    if (s.leaf && (now - s.t > GAP_MS || Math.sign(dx) !== Math.sign(s.acc))) s.leaf = null;
    s.t = now;
    if (!s.leaf) {
      if (now - this.vT < LOCK_MS || Math.abs(e.deltaX) <= RATIO * Math.abs(e.deltaY)) return;
      const leaf = this.leafAt(e.target);
      if (!leaf || NO_SWIPE.includes(leaf.view.getViewType())) return;
      if (this.scrollsX(e.target, leaf.view.containerEl, e.deltaX)) return;
      s.leaf = leaf;
      s.acc = 0;
    }
    e.preventDefault();
    s.acc += dx;
    if (Math.abs(s.acc) < INK_STEP) return;
    const h = s.leaf.history, d = Math.sign(s.acc);
    s.leaf = null;
    s.acc = 0;
    s.swallow = true;
    Promise.resolve().then(() => (d > 0 ? h.back() : h.forward())).catch((err) => console.error("swipe-nav", err));
  }

  onWheel(e) {
    if (!this.g && this.eink()) return this.onWheelInk(e);
    let g = this.g;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) { // vertical during the gesture doesn't scroll the note
      if (g && !this.offAxis(g, e)) e.preventDefault();
      else if (e.deltaY) this.vT = performance.now();
      return;
    }
    const now = performance.now();
    if (now - this.lastT > GAP_MS || Math.sign(e.deltaX) !== Math.sign(this.lastDx)) this.inertia = false;
    this.lastT = now;
    this.lastDx = e.deltaX;
    if (!g) {
      if (now - this.vT < LOCK_MS || Math.abs(e.deltaX) <= RATIO * Math.abs(e.deltaY)) return; // diagonal scroll: let it scroll
      const leaf = this.leafAt(e.target);
      if (!leaf || NO_SWIPE.includes(leaf.view.getViewType())) return; // Excalidraw/Graph/Canvas: canvas pan, no swipe
      if (this.scrollsX(e.target, leaf.view.containerEl, e.deltaX)) return; // wide table/code: let it scroll
      e.preventDefault();
      if (this.inertia) return;
      g = this.g = this.start(leaf);
    }
    e.preventDefault();
    if (g.committing) return;
    if (g.released) { // dragging again during the return animation
      g.released = false;
      g.raw = g.x * this.settings.distance + Math.sign(g.x) * DEAD;
    }
    const dx = e.deltaX * (e.deltaMode === 1 ? 16 : 1);
    g.ay += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
    this.feed(g, (this.settings.invert ? 1 : -1) * dx); // fingers to the right ⇒ negative deltaX ⇒ back
    window.clearTimeout(g.timer);
    g.timer = window.setTimeout(() => this.release(g), RELEASE_MS);
  }

  leafAt(target) {
    let found = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!found && leaf.history && leaf.view.containerEl.contains(target)) found = leaf;
    });
    return found;
  }

  scrollsX(el, stop, dx) {
    for (; el && el !== stop; el = el.parentElement) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const ov = getComputedStyle(el).overflowX;
      if (ov !== "auto" && ov !== "scroll") continue;
      if (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
      if (dx < 0 && el.scrollLeft > 0) return true;
    }
    return false;
  }

  start(leaf) {
    const view = leaf.view;
    view.containerEl.addClass("swipe-nav-active");
    const comp = new Component();
    comp.load();
    const g = { leaf, container: view.containerEl, content: view.contentEl, comp,
      raw: 0, ay: 0, armed: false, tgt: 0, x: 0, dir: 0, vx: 0, lt: 0, hist: [], under: {}, committing: false, released: false, timer: null, raf: null };
    this.under(g, 1); // pre-build both previews before they show up
    this.under(g, -1);
    return g;
  }

  entry(g, d) {
    const h = g.leaf.history;
    const list = d > 0 ? h.backHistory : h.forwardHistory;
    return list && list.length ? list[list.length - 1] : null;
  }

  // preview of the target note (rendered once per direction)
  under(g, d) {
    if (g.under[d] !== undefined) return g.under[d];
    const e = this.entry(g, d);
    if (!e) return (g.under[d] = null);
    const el = g.container.createDiv({ cls: d < 0 ? "swipe-nav-under swipe-nav-over" : "swipe-nav-under" }); // forward comes over, back stays under
    el.style.top = g.content.offsetTop + "px";
    el.hide();
    // same DOM structure as Obsidian ⇒ the theme applies readable width, margins and fonts like the real note
    const cfg = (k) => this.app.vault.getConfig(k);
    const view = el.createDiv({ cls: "markdown-reading-view swipe-nav-preview" })
      .createDiv({ cls: "markdown-preview-view markdown-rendered" + (cfg("readableLineLength") !== false ? " is-readable-line-width" : "")
        + (cfg("propertiesInDocument") !== "hidden" ? " show-properties" : "") }); // without show-properties Obsidian's CSS hides the properties
    const sizer = view.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    const header = sizer.createDiv({ cls: "mod-header" });
    const inner = sizer.createDiv({ cls: "swipe-nav-body" });
    const path = e.state && e.state.state && e.state.state.file;
    const f = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (cfg("showInlineTitle") !== false)
      header.createDiv({ cls: "inline-title", text: f instanceof TFile ? f.basename : (e.title || "") });
    if (f instanceof TFile && cfg("propertiesInDocument") !== "hidden") this.props(header, f);
    if (f instanceof TFile && f.extension === "md") {
      const sl = this.scrollLine(e);
      this.app.vault.cachedRead(f).then((md) => {
        if (sl) md = md.split("\n").slice(0, Math.ceil(sl) + 120).join("\n"); // scrolled: render up to the visible area
        md = md.replace(/^---\n[\s\S]*?\n---\n?/, "");
        if (!sl) md = md.slice(0, 4000);
        return MarkdownRenderer.render(this.app, md, inner, f.path, g.comp);
      }).then(() => { // cm-active ⇒ the theme applies the same active-line highlight
        this.spacing(inner, f);
        const el = this.activeEl(inner, f, e);
        if (el) el.addClass("cm-active");
        const h = el && /^H([1-6])$/.exec(el.tagName); // LP shows the raw "# " on the active line's heading
        if (h) el.prepend(createSpan({ cls: `cm-formatting cm-formatting-header cm-formatting-header-${h[1]}`,
          text: "#".repeat(+h[1]) + " " }));
        const u = g.under[d]; // (here `el` is the active element)
        if (sl && u) {
          u.applyScroll = () => this.scrollTo(view, inner, f, sl);
          if (u.style.display !== "none") u.applyScroll();
        }
      }).catch(() => {});
    }
    return (g.under[d] = el);
  }

  // line at the top of the screen Obsidian will restore when going back (0 = top)
  scrollLine(e) {
    const s = e.eState && e.eState.scroll;
    return typeof s === "number" && s > 0 ? s : 0;
  }

  // scroll the preview to the same line ⇒ no jump when swapping preview → real note
  scrollTo(view, inner, f, line) {
    const secs = ((this.app.metadataCache.getFileCache(f) || {}).sections || []).filter((s) => s.type !== "yaml");
    const i = secs.findIndex((s) => line < s.position.end.line + 1);
    const el = i >= 0 ? inner.children[i] : null;
    if (!el) return;
    const p = secs[i].position, frac = Math.max(0, Math.min(1, (line - p.start.line) / (p.end.line - p.start.line + 1)));
    view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top + frac * el.offsetHeight;
  }

  // header title: clone over the original with the target path, fades in with progress
  title(g, d, q) {
    if (g.title === undefined) {
      const orig = g.container.querySelector(".view-header-title-container");
      g.title = orig ? { orig, ghosts: {} } : null;
    }
    const t = g.title;
    if (!t) return;
    const e = d ? this.entry(g, d) : null;
    if (e && t.ghosts[d] === undefined) t.ghosts[d] = this.titleGhost(t.orig, e);
    const ghost = e ? t.ghosts[d] : null;
    for (const k in t.ghosts) if (t.ghosts[k] && t.ghosts[k] !== ghost) t.ghosts[k].setCssProps({ opacity: "0" });
    const s = Math.max(0, Math.min(1, (q - 0.25) / 0.5));
    if (ghost) ghost.style.opacity = s;
    t.orig.style.opacity = ghost ? 1 - s : "";
    // tab: swap the name together with the header (halfway through the fade)
    const tab = g.leaf.tabHeaderInnerTitleEl;
    if (tab) tab.textContent = ghost && s > 0.5 ? ghost.querySelector(".view-header-title").textContent : g.leaf.getDisplayText();
  }

  titleGhost(orig, e) {
    const path = e.state && e.state.state && e.state.state.file;
    const f = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(f instanceof TFile)) return null;
    const el = orig.cloneNode(true);
    const name = el.querySelector(".view-header-title");
    if (!name) return null;
    name.removeAttribute("contenteditable");
    name.textContent = f.basename;
    const parent = el.querySelector(".view-header-title-parent");
    if (parent) {
      const crumb = orig.querySelector(".view-header-breadcrumb"), sep = orig.querySelector(".view-header-breadcrumb-separator");
      parent.empty();
      const folders = f.parent && f.parent.path !== "/" ? f.parent.path.split("/") : [];
      for (const part of folders) {
        parent.createSpan({ cls: crumb ? crumb.className : "view-header-breadcrumb", text: part });
        parent.createSpan({ cls: sep ? sep.className : "view-header-breadcrumb-separator", text: sep ? sep.textContent : "/" });
      }
    }
    const host = orig.parentElement, r = orig.getBoundingClientRect(), hr = host.getBoundingClientRect();
    host.addClass("swipe-nav-title-host");
    Object.assign(el.style, { position: "absolute", left: r.left - hr.left + "px", top: r.top - hr.top + "px",
      height: r.height + "px", maxWidth: hr.right - r.left + "px", margin: "0", opacity: "0", pointerEvents: "none" });
    host.appendChild(el);
    return el;
  }

  // spacing like Live Preview: blank line = 1 line of height (the CSS zeroes reading-mode margins)
  spacing(inner, f) {
    const cache = this.app.metadataCache.getFileCache(f) || {};
    const secs = (cache.sections || []).filter((s) => s.type !== "yaml");
    const lh = parseFloat(getComputedStyle(inner).lineHeight) || 24;
    let prev = cache.frontmatterPosition ? cache.frontmatterPosition.end.line : -1, prevHead = false;
    [...inner.children].forEach((c, i) => {
      const s = secs[i];
      if (!s) return;
      const n = s.position.start.line - prev - 1, head = s.type === "heading";
      // hr: in LP the theme margin adds to blank lines (here it would collapse) ⇒ top margin added, bottom becomes padding
      const hr = c.tagName === "HR" && getComputedStyle(c), hrTop = hr ? parseFloat(hr.marginTop) || 0 : 0, hrBot = hr && hr.marginBottom;
      c.style.setProperty("margin-top", n * lh + hrTop + "px", "important");
      if (hr) { c.addClass("swipe-nav-hr"); c.style.paddingBottom = hrBot; }
      if (prevHead && !head && n === 0) c.addClass("swipe-nav-after-heading"); // LP CSS rules for the line after a heading
      if (prevHead && head && n === 1) c.addClass("swipe-nav-heading-gap");
      prev = s.position.end.line;
      prevHead = head;
    });
  }

  // rendered element where the cursor will be when going back (line saved in history; without it, 1st block)
  activeEl(inner, f, e) {
    const cur = e.eState && e.eState.cursor;
    const line = cur && (cur.from || cur.head) ? (cur.from || cur.head).line : null;
    const cache = this.app.metadataCache.getFileCache(f) || {};
    if (line == null || !cache.sections) return inner.firstElementChild;
    const items = cache.listItems || [];
    const li = items.findIndex((it) => it.position.start.line === line);
    if (li >= 0) return inner.querySelectorAll("li")[li] || null; // list: only the line's item
    const secs = cache.sections.filter((s) => s.type !== "yaml");
    const i = secs.findIndex((s) => s.position.start.line <= line && line <= s.position.end.line);
    return i >= 0 ? inner.children[i] || null : null; // blank line ⇒ no visible highlight
  }

  // "Properties" block with the same DOM structure and widgets (internal API) as Obsidian's real editor
  props(parent, f) {
    const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
    const keys = fm ? Object.keys(fm).filter((k) => k !== "position") : [];
    if (!keys.length) return;
    const mtm = this.app.metadataTypeManager;
    const box = parent.createDiv({ cls: "metadata-container", attr: { "data-property-count": keys.length } });
    const head = box.createDiv({ cls: "metadata-properties-heading" });
    setIcon(head.createDiv({ cls: "collapse-indicator collapse-icon" }), "right-triangle");
    head.createDiv({ cls: "metadata-properties-title", text: "Properties" });
    const content = box.createDiv({ cls: "metadata-content" });
    const list = content.createDiv({ cls: "metadata-properties" });
    for (const k of keys) {
      const v = fm[k];
      const row = list.createDiv({ cls: "metadata-property", attr: { "data-property-key": k.toLowerCase() } });
      const key = row.createDiv({ cls: "metadata-property-key" });
      const icon = key.createSpan({ cls: "metadata-property-icon" });
      key.createEl("input", { cls: "metadata-property-key-input", type: "text", value: k, attr: { readonly: "" } });
      const val = row.createDiv({ cls: "metadata-property-value" });
      try {
        const ti = mtm.getTypeInfo(k, v);
        setIcon(icon, ti.expected.icon);
        val.setAttr("data-property-type", ti.inferred.type);
        ti.inferred.render(val, v, { app: this.app, key: k, sourcePath: f.path, hoverSource: "preview",
          onChange: () => {}, blur: () => {} });
      } catch { // internal API changed: fall back to plain text
        setIcon(icon, "lucide-text");
        val.setText(Array.isArray(v) ? v.join(", ") : String(v ?? ""));
      }
    }
    const add = content.createDiv({ cls: "metadata-add-button text-icon-button" });
    setIcon(add.createSpan({ cls: "text-button-icon" }), "lucide-plus");
    add.createSpan({ cls: "text-button-label", text: "Add property" });
  }

  feed(g, delta) {
    g.raw += delta;
    g.hist.push([performance.now(), delta]);
    if (Math.abs(g.raw) < DEAD) return;
    if (!g.armed) { // left the dead zone: only counts if the accumulated drag was horizontal
      if (this.diagonal(g)) return this.cancel(g);
      g.armed = true;
    }
    g.dir = Math.sign(g.raw);
    const n = (g.raw - g.dir * DEAD) / this.settings.distance;
    g.tgt = this.entry(g, g.dir)
      ? Math.max(-2, Math.min(2, n))                       // follow the finger 1:1
      : Math.sign(n) * 0.18 * Math.tanh(Math.abs(n) * 3);  // end of history: resistance
    if (Math.abs(g.tgt) >= 1.8 && this.entry(g, g.dir)) return this.commit(g); // reached the end: navigate now, without waiting for release
    this.kick(g);
  }

  // accumulated dy too high for the accumulated dx ⇒ it was a diagonal scroll
  diagonal(g) {
    return RATIO * g.ay > Math.max(Math.abs(g.raw), DEAD / 2);
  }

  // vertical within the dead zone: add to dy; diagonal ⇒ cancel and give the scroll back
  offAxis(g, e) {
    g.ay += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
    if (g.armed || !this.diagonal(g)) return false;
    this.cancel(g);
    return true;
  }

  cancel(g) {
    if (this.g === g) this.cleanup();
    this.vT = performance.now(); // axis lock: don't restart the gesture mid-scroll
  }

  // events stopped (touchpad can't tell still from released): ≥ 20% of the screen OR flick ⇒ navigate; else snap back
  release(g) {
    if (this.g !== g || g.committing || g.released) return;
    const last = g.hist.length ? g.hist[g.hist.length - 1][0] : 0;
    const vel = g.dir * g.hist.filter((h) => h[0] > last - 80).reduce((s, h) => s + h[1], 0) / 80 * 1000 / this.settings.distance;
    const a = Math.abs(g.tgt);
    g.hist = [];
    if (g.dir && this.entry(g, g.dir) && (a >= COMMIT || (vel > 1.2 && a >= 0.3))) return this.commit(g);
    g.raw = 0;
    g.released = true;
    g.tgt = 0;
    this.kick(g);
  }

  commit(g) {
    window.clearTimeout(g.timer);
    this.inertia = true; // rest of the drag + inertia don't open a new gesture
    g.committing = true;
    g.tgt = g.dir * 2;
    // Hermite curve: starts at the current screen velocity and ends with velocity 0 (no "bump")
    const D = g.tgt - g.x;
    g.c0 = performance.now();
    g.x0 = g.x;
    g.cT = Math.max(160, Math.min(300, 120 + Math.abs(D) * 120));
    let m = g.vx * g.cT;
    if (Math.sign(m) !== Math.sign(D)) m = 0;
    if (Math.abs(m) > 2.5 * Math.abs(D)) m = 2.5 * D; // avoid overshooting
    g.m0 = m;
    this.kick(g);
  }

  kick(g) {
    if (!g.raf) g.raf = window.requestAnimationFrame(() => this.step(g));
  }

  step(g) {
    g.raf = null;
    if (this.g !== g) return;
    const now = performance.now(), dt = g.lt ? Math.min(50, now - g.lt) : 1000 / 60, px = g.x;
    g.lt = now;
    if (g.committing) {
      const t = Math.min(1, (now - g.c0) / g.cT), D = g.tgt - g.x0;
      g.x = g.x0 + (t * t * t - 2 * t * t + t) * g.m0 + (-2 * t * t * t + 3 * t * t) * D;
      if (t >= 1) {
        g.x = g.tgt;
        this.render(g);
        this.navigate(g);
        return;
      }
      this.render(g);
      this.kick(g);
      return;
    }
    g.x += (g.tgt - g.x) * (1 - Math.pow(1 - SMOOTH, dt / (1000 / 60))); // time-based: same at 60/120/144Hz
    g.vx = 0.5 * g.vx + 0.5 * (g.x - px) / dt;
    this.render(g);
    if (Math.abs(g.tgt - g.x) > 1e-3) this.kick(g);
    else if (g.released) this.cleanup();
    else { g.x = g.tgt; g.vx = 0; g.lt = 0; this.render(g); }
  }

  render(g) {
    const W = g.content.clientWidth, d = Math.sign(g.x) || g.dir, a = Math.abs(g.x);
    const q = Math.min(a / 2, 1), p = Math.min(a, 1);
    const u = d ? this.under(g, d) : null;
    for (const k in g.under) if (g.under[k] && g.under[k] !== u) g.under[k].hide();
    const c = g.content.style;
    // shadow fades over the last 30% and is clipped at the header (doesn't vanish abruptly on swap)
    const sh = `0 0 ${30 * p}px rgba(0,0,0,${(0.6 * Math.min(1, (1 - q) / 0.3)).toFixed(3)})`, clip = "inset(0 0 0 -40px)";
    if (u && u.style.display === "none") {
      u.show();
      if (u.applyScroll) u.applyScroll();
    }
    if (d < 0 && u) { // forward: next note comes OVER, entering from the right
      u.style.transform = `translateX(${(1 - q) * W}px)`;
      u.style.boxShadow = sh;
      u.style.clipPath = clip;
      c.transform = `translateX(${-q * W * 0.22}px)`;
      c.filter = `brightness(${1 - 0.45 * q})`;
      c.boxShadow = "none";
    } else { // back: current note leaves and reveals the previous one UNDERNEATH
      c.transform = `translateX(${g.x * W * 0.5}px)`;
      c.filter = "none";
      c.boxShadow = a > 0.01 ? sh : "none";
      c.clipPath = clip;
      if (u) {
        u.style.transform = `translateX(${-d * (1 - q) * W * 0.22}px)`;
        u.style.filter = `brightness(${0.55 + 0.45 * q})`;
      }
    }
    this.title(g, d, q);
  }

  async navigate(g) {
    try {
      const h = g.leaf.history;
      await (g.dir > 0 ? h.back() : h.forward());
    } catch (err) {
      console.error("swipe-nav", err);
    }
    // wait for Obsidian to paint the new note before removing the preview
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => { if (this.g === g) this.cleanup(); }));
  }

  cleanup() {
    const g = this.g;
    this.g = null;
    window.clearTimeout(g.timer);
    if (g.raf) window.cancelAnimationFrame(g.raf);
    for (const k in g.under) if (g.under[k]) g.under[k].remove();
    g.comp.unload();
    const c = g.content.style;
    c.transform = c.filter = c.boxShadow = c.clipPath = "";
    if (g.title) {
      for (const k in g.title.ghosts) if (g.title.ghosts[k]) g.title.ghosts[k].remove();
      g.title.orig.setCssProps({ opacity: "" });
      g.title.orig.parentElement.removeClass("swipe-nav-title-host");
    }
    if (g.leaf.tabHeaderInnerTitleEl) g.leaf.tabHeaderInnerTitleEl.textContent = g.leaf.getDisplayText();
    g.container.removeClass("swipe-nav-active");
  }
}

// ===== Graph: zoom out at cursor =====
const GRAPH_TYPES = ["graph", "localgraph"];

// Obsidian (onWheel): zoom out resets zoomCenter → updateZoom anchors at the screen center.
// Here: store the mouse position on wheel and, on the next updateZoom, replace the (0,0) with it.
// Can also be turned off from the graph view's 3-dot menu (onPaneMenu, source "more-options").
class GraphZoomCursor extends Component {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.app = plugin.app;
  }

  onload() {
    this.windows = new Set();
    this.menuPatches = new Map(); // proto -> { original, own }
    this.proto = null;

    this.hookWindow(window);
    this.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.hookWindow(win)));
    this.app.workspace.onLayoutReady(() => this.refresh());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
  }

  onunload() {
    if (this.proto) this.proto.updateZoom = this.original;
    for (const [proto, { original, own }] of this.menuPatches) {
      if (own) proto.onPaneMenu = original;
      else delete proto.onPaneMenu;
    }
  }

  // wheel must be listened to on every window (popouts have their own window)
  hookWindow(win) {
    if (!win || this.windows.has(win)) return;
    this.windows.add(win);
    this.registerDomEvent(win, "wheel", (e) => {
      const r = this.rendererAt(e.target);
      if (r) r._gzcAnchor = { x: e.offsetX, y: e.offsetY, dpr: win.devicePixelRatio };
    }, { capture: true, passive: true });
  }

  leaves() {
    return GRAPH_TYPES.flatMap((t) => this.app.workspace.getLeavesOfType(t));
  }

  renderers() {
    return this.leaves().map((l) => l.view?.renderer).filter(Boolean);
  }

  rendererAt(target) {
    return this.renderers().find((r) => r.interactiveEl === target);
  }

  refresh() {
    if (!this._loaded) return;
    for (const leaf of this.leaves()) {
      this.hookWindow(leaf.view.containerEl?.ownerDocument?.defaultView);
      this.patchMenu(Object.getPrototypeOf(leaf.view));
    }
    this.tryPatch();
  }

  // item in the graph view's 3-dot menu
  patchMenu(proto) {
    if (this.menuPatches.has(proto)) return;
    const original = proto.onPaneMenu;
    this.menuPatches.set(proto, { original, own: Object.prototype.hasOwnProperty.call(proto, "onPaneMenu") });
    const plugin = this.plugin;
    proto.onPaneMenu = function (menu, source) {
      original?.apply(this, arguments);
      if (source === "more-options") {
        menu.addItem((item) => item
          .setTitle("Zoom out at cursor")
          .setIcon("mouse-pointer-click")
          .setSection("view")
          .setChecked(true)
          .onClick(async () => {
            await plugin.setEnabled("graph-zoom-cursor", false);
            new Notice("Zoom out at cursor: off (turn it back on in Laptop QoL settings)");
          }));
      }
    };
  }

  // the renderer class isn't exported: grab the prototype from the first open instance
  tryPatch() {
    if (this.proto) return;
    const r = this.renderers()[0];
    if (!r || typeof r.updateZoom !== "function") return;
    const proto = Object.getPrototypeOf(r);
    const original = proto.updateZoom;
    proto.updateZoom = function () {
      const a = this._gzcAnchor;
      this._gzcAnchor = null;
      if (a && this.zoomCenterX === 0 && this.zoomCenterY === 0) {
        this.zoomCenterX = a.x * a.dpr;
        this.zoomCenterY = a.y * a.dpr;
      }
      return original.apply(this, arguments);
    };
    this.proto = proto;
    this.original = original;
  }
}

// ===== Sub-plugin registry =====
const MODULES = [
  {
    id: "swipe-nav",
    name: "Swipe Nav",
    desc: "Swipe 2 fingers on the touchpad to go back/forward between notes, like in browsers (Safari-style slide).",
    cls: SwipeNav,
    defaults: { invert: false, distance: 600 },
    settings: [
      { name: "Invert direction", desc: "Turn on if swiping right goes forward instead of back.",
        control: { type: "toggle", key: "invert" } },
      { name: "Swipe distance", desc: "The higher, the further you need to swipe (default 600).",
        control: { type: "slider", key: "distance", min: 150, max: 1500, step: 25 } },
    ],
  },
  {
    id: "graph-zoom-cursor",
    name: "Graph: zoom out at cursor",
    desc: "Makes graph view zoom out anchor at the cursor (like zoom in) instead of the screen center.",
    cls: GraphZoomCursor,
    defaults: {},
  },
];

module.exports = class LaptopQoL extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = {};
    for (const m of MODULES) this.settings[m.id] = Object.assign({ enabled: true }, m.defaults, data[m.id]);
    this.active = new Map();
    this.addSettingTab(new QolTab(this.app, this));
    for (const m of MODULES) if (this.settings[m.id].enabled) this.start(m);
  }

  start(m) {
    if (!this.active.has(m.id)) this.active.set(m.id, this.addChild(new m.cls(this, this.settings[m.id])));
  }

  stop(m) {
    const c = this.active.get(m.id);
    if (!c) return;
    this.removeChild(c);
    this.active.delete(m.id);
  }

  async setEnabled(id, on) {
    const m = MODULES.find((x) => x.id === id);
    this.settings[id].enabled = on;
    on ? this.start(m) : this.stop(m);
    await this.saveSettings();
  }

  saveSettings() {
    return this.saveData(this.settings);
  }
};

// declarative settings (1.13+): one group per module, control keys are "<module id>.<field>"
class QolTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions() {
    return MODULES.map((m) => {
      const s = this.plugin.settings[m.id];
      return { type: "group", items: [
        { name: m.name, desc: m.desc, control: { type: "toggle", key: `${m.id}.enabled` } },
        ...(m.settings || []).map((d) => ({ ...d, control: { ...d.control, key: `${m.id}.${d.control.key}` }, visible: () => s.enabled })),
      ] };
    });
  }

  getControlValue(key) {
    const [id, field] = key.split(".");
    return this.plugin.settings[id][field];
  }

  async setControlValue(key, value) {
    const [id, field] = key.split(".");
    if (field === "enabled") {
      await this.plugin.setEnabled(id, value);
      this.refreshDomState(); // show/hide the module's sub-settings
    } else {
      this.plugin.settings[id][field] = value;
      await this.plugin.saveSettings();
    }
  }
}
