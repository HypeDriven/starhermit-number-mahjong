// The look of the menus, HUD, rail, tray, banners and dialogs: the browser
// build's css/main.css, rewritten class-based in tools/ui-style.css and
// converted once with `starhermit css` into assets/ui-style.json
// (`npm run css`), registered at start with the theme the runtime's own
// widgets (dialogs, scroll bars, selects, check boxes) take. The tokens follow
// the round's cosmetic theme (content.js THEMES css: bg, panel, ink, accent,
// muted) as #app's custom properties did, with the old color-mix() shades
// precomputed; the colour-vision palettes move the accent as
// #app[data-palette] did and the runtime's high contrast darkens the panels.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { Theme } from "./game.ts";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
const PALETTE_ACCENT: Record<string, string> = { deuteranopia: "#e8c34b", protanopia: "#58b8e0", tritanopia: "#e87a90" };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 12, radius: 10,
    text: "#ece4d4", muted: "#9b94a8", panel: "#232838", control: "#2b3144", hovered: "#363d55",
    pressed: "#232838", field: "#2b3144", accent: "#e8b34b", focus: "#e8b34b", outline: "#ece4d438",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    // main.css: a 3 px accent outline 2 px off every focusable element
    widget: { focusRing: { color: "$accent", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$muted", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .overlay > .sheet: the pause sheet over a 55 % black dim of the round
    dialog: { ...(css.styles[".sheet"] as ui.Style), parts: { backdrop: { background: "#0000008c" } } },
  });
}

/** #rrggbb mixed with #rrggbb (`k` of a), as color-mix(in srgb, a k, b). */
export function mix(a: string, b: string, k: number): string {
  const p = (s: string, i: number): number => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) * k + p(b, i) * (1 - k)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
const alpha = (hex: string, a: number): string => hex.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");

let key = "";
let current: Tokens = {};
/** The round's theme colours, the palette's accent and high contrast as tokens. */
export function applyTokens(theme: Theme, palette: string, highContrast: boolean): void {
  const k = `${theme.css.bg}:${theme.css.accent}:${palette}:${highContrast}`;
  if (k === key) return;
  key = k;
  const css = theme.css;
  const accent = PALETTE_ACCENT[palette] ?? css.accent;
  const panel = highContrast ? mix(css.bg, "#000000", 0.7) : css.panel;
  current = {
    ...base,
    bg: css.bg, panel, ink: css.ink, accent, muted: css.muted, tile: theme.tile, "tile-ink": theme.ink,
    btn: alpha(panel, 0.8), line: alpha(css.ink, highContrast ? 0.5 : 0.22), edge: alpha(css.ink, highContrast ? 0.4 : 0.14), hud: alpha(css.bg, 0.92),
  };
  ui.setTokens(current);
}
/** A token's current colour (for hand-drawn pieces: draw.* takes real colours). */
export function token(name: string): string { return String(current[name] ?? base[name] ?? "#000000"); }
