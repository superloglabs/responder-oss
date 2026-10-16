import { useEffect, useRef } from "react";
import "./hairline-computer.css";

// An isometric line drawing of a computer whose terminal streams logs. Log
// lines type in, the terminal scrolls, keys press and a CRT sweep passes down
// the screen. With reduced motion the drawing stays on one frame.

type Point3 = readonly [number, number, number];
type Attributes = Record<string, number | string>;

const NS = "http://www.w3.org/2000/svg";
const C = Math.cos(Math.PI / 6);
const S = 0.5;
const ORIGIN = [250, 250] as const;
const WIDTH = 460;

const P = (x: number, y: number, z: number): [number, number] => [ORIGIN[0] + (x - y) * C, ORIGIN[1] + (x + y) * S - z];

const services = ["checkout", "api-gw", "billing", "payments", "worker"];
const messages = {
  ERR: ["timeout payments", "500 POST /pay", "db conn refused", "nil pointer deref"],
  INF: ["POST /cart 200 12ms", "GET /orders 200 8ms", "job sync done 340ms", "span exported x24", "cache hit user:4121", "GET /health 200 1ms", "invoice 8812 queued"],
  WRN: ["retry 2/3 stripe", "slow query 1.2s", "pool 90% in use", "rate limit near"],
} as const;
type Level = keyof typeof messages;

function draw(svg: SVGSVGElement, animate: boolean): () => void {
  svg.replaceChildren();
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Attributes = {}, parent: Element = svg): SVGElementTagNameMap[K] => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.appendChild(node);
    return node;
  };
  const points = (list: Point3[]) => list.map((point) => P(...point).map((value) => value.toFixed(2)).join(",")).join(" ");
  const poly = (list: Point3[], className: string, parent: Element = svg) => el("polygon", { class: className, points: points(list) }, parent);
  const line = (a: Point3, b: Point3, className: string, parent: Element = svg) => {
    const [x1, y1] = P(...a);
    const [x2, y2] = P(...b);
    return el("line", { class: className, x1, x2, y1, y2 }, parent);
  };
  // Groups whose (u, v) coordinates lie on a face of the drawing.
  const frontPlane = (x: number, y: number, z: number, parent: Element = svg) => {
    const [X, Y] = P(x, y, z);
    return el("g", { transform: `matrix(${C},${S},0,1,${X},${Y})` }, parent);
  };
  const rightPlane = (x: number, y: number, z: number, parent: Element = svg) => {
    const [X, Y] = P(x, y, z);
    return el("g", { transform: `matrix(${C},${-S},0,1,${X},${Y})` }, parent);
  };
  const topPlane = (x: number, y: number, z: number, parent: Element = svg) => {
    const [X, Y] = P(x, y, z);
    return el("g", { transform: `matrix(${C},${S},${-C},${S},${X},${Y})` }, parent);
  };
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, parent: Element = svg) => {
    const g = el("g", {}, parent);
    poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], "hairline__edge hairline__fill", g);
    poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], "hairline__edge hairline__fill", g);
    poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], "hairline__edge hairline__fill", g);
    return g;
  };

  const defs = el("defs");
  const sweepGradient = el("linearGradient", { id: "hairlineSweep", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
  el("stop", { offset: 0, "stop-color": "#171715", "stop-opacity": 0 }, sweepGradient);
  el("stop", { offset: 0.6, "stop-color": "#171715", "stop-opacity": 0.06 }, sweepGradient);
  el("stop", { offset: 1, "stop-color": "#171715", "stop-opacity": 0 }, sweepGradient);
  const scanlines = el("pattern", { height: 1.6, id: "hairlineScanlines", patternUnits: "userSpaceOnUse", width: 4 }, defs);
  el("rect", { fill: "#171715", "fill-opacity": 0.04, height: 0.5, width: 4 }, scanlines);

  // Ground shadow.
  poly([[-2, -2, 0], [232, -2, 0], [232, 214, 0], [-2, 214, 0]], "hairline__shadow");

  // Base with a chamfered front edge.
  const B = { h: 26, lip: 12, x0: 0, x1: 222, y0: 0, y1: 204 };
  {
    const g = el("g");
    const { h, lip, x0, x1, y0, y1 } = B;
    poly([[x1, y0, 0], [x1, y1, 0], [x1, y1, h - 8], [x1, y1 - lip, h], [x1, y0, h]], "hairline__edge hairline__fill", g);
    poly([[x0, y1, 0], [x1, y1, 0], [x1, y1, h - 8], [x0, y1, h - 8]], "hairline__edge hairline__fill", g);
    poly([[x0, y1, h - 8], [x1, y1, h - 8], [x1, y1 - lip, h], [x0, y1 - lip, h]], "hairline__edge hairline__fill", g);
    poly([[x0, y0, h], [x1, y0, h], [x1, y1 - lip, h], [x0, y1 - lip, h]], "hairline__edge hairline__fill", g);
    line([x0, y1, 4], [x1, y1, 4], "hairline__lo", g);
    line([x1, y1, 4], [x1, y0, 4], "hairline__lo", g);
    const side = rightPlane(x1, y1 - lip, 22, g);
    for (let i = 0; i < 8; i++) el("line", { class: "hairline__lo", x1: 12 + i * 5, x2: 12 + i * 5, y1: 4, y2: 12 }, side);
    el("rect", { class: "hairline__mid", height: 8, rx: 4, width: 12, x: 92, y: 3 }, side);
    el("line", { class: "hairline__mid", x1: 98, x2: 98, y1: 4.5, y2: 9.5 }, side);
    el("rect", { class: "hairline__mid", height: 8, rx: 1.5, width: 18, x: 106, y: 4 }, side);
    el("rect", { class: "hairline__lo", height: 4, rx: 1, width: 12, x: 109, y: 6 }, side);
    el("rect", { class: "hairline__lo", height: 5, rx: 1, width: 9, x: 134, y: 5 }, side);
    const label = frontPlane(x0, y1, h - 8, g);
    el("text", { class: "hairline__label", "font-size": 4.2, "letter-spacing": 0.6, x: 10, y: 5.8 }, label).textContent = "RESPONDER ONE";
  }

  // Monitor: a tapered CRT shell behind a front shell.
  const M = { x0: 30, x1: 192, yF: 98, yR: 56, z0: B.h, z1: B.h + 150 };
  const monitor = el("g");
  box(46, 178, 12, M.yR, M.z0, M.z1 - 18, monitor);
  const rearSide = rightPlane(178, M.yR, M.z1 - 18, monitor);
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 6; i++) el("rect", { class: "hairline__lo", height: 6, rx: 1.2, width: 2.4, x: 6 + i * 6, y: 12 + row * 9 }, rearSide);
  }
  el("rect", { class: "hairline__lo", height: 14, rx: 7, width: 66, x: 0, y: 0 }, topPlane(80, 20, M.z1 - 18, monitor));
  box(M.x0, M.x1, M.yR, M.yF, M.z0, M.z1, monitor);
  line([M.x0, M.yF - 6, M.z1], [M.x1, M.yF - 6, M.z1], "hairline__lo", monitor);
  line([M.x1, M.yF - 6, M.z1], [M.x1, M.yF - 6, M.z0], "hairline__lo", monitor);

  const screen = { h: 98, r: 9, u: 14, v: 14, w: 134 };
  const front = frontPlane(M.x0, M.yF, M.z1, monitor);
  el("rect", { class: "hairline__mid", height: screen.h + 8, rx: screen.r + 3, width: screen.w + 8, x: screen.u - 4, y: screen.v - 4 }, front);
  el("rect", { class: "hairline__edge", height: screen.h, rx: screen.r, width: screen.w, x: screen.u, y: screen.v }, front);
  el("path", { class: "hairline__lo", d: `M ${screen.u + 2} ${screen.v + screen.h - 6} q 0 4 4 6` }, front);
  // The glass sits slightly behind the bezel.
  const glassPlane = frontPlane(M.x0, M.yF - 4, M.z1, monitor);
  const G = { h: screen.h - 6, r: screen.r, u: screen.u + 3, v: screen.v + 3, w: screen.w - 6 };
  el("rect", { class: "hairline__hi hairline__glass", height: G.h, rx: G.r, width: G.w, x: G.u, y: G.v }, glassPlane);
  const glassClip = el("clipPath", { clipPathUnits: "userSpaceOnUse", id: "hairlineGlass" }, defs);
  el("rect", { height: G.h - 2, rx: G.r - 1, width: G.w - 2, x: G.u + 1, y: G.v + 1 }, glassClip);
  const glass = el("g", { "clip-path": "url(#hairlineGlass)" }, glassPlane);
  el("rect", { fill: "url(#hairlineScanlines)", height: G.h, width: G.w, x: G.u, y: G.v }, glass);

  // Terminal.
  const T = { fontSize: 4.3, lineHeight: 6.6, rows: 10, top: G.v + 7, x: G.u + 7 };
  el("text", { class: "hairline__mono", fill: "#a3a39e", "font-size": 3.6, x: T.x, y: T.top + 3 }, glass).textContent = "$ tail -f app.log";
  el("line", { stroke: "#e2e2df", "stroke-width": 0.5, x1: G.u + 5, x2: G.u + G.w - 5, y1: T.top + 7, y2: T.top + 7 }, glass);
  const liveDot = el("circle", { cx: G.u + G.w - 9, cy: T.top + 1.8, fill: "#171715", r: 1.4 }, glass);
  const logClip = el("clipPath", { clipPathUnits: "userSpaceOnUse", id: "hairlineLog" }, defs);
  el("rect", { height: G.h, width: G.w, x: G.u, y: T.top + 8 }, logClip);
  const logArea = el("g", { "clip-path": "url(#hairlineLog)" }, glass);
  const logScroll = el("g", {}, logArea);
  const cursor = el("rect", { fill: "#171715", height: 4.2, width: 2.6 }, glass);
  const sweep = el("rect", { fill: "url(#hairlineSweep)", height: 18, width: G.w, x: G.u, y: G.v + 30 }, glass);
  el("path", { d: `M ${G.u + 8} ${G.v + 2} L ${G.u + 34} ${G.v + 2} L ${G.u + 2} ${G.v + 40} L ${G.u + 2} ${G.v + 18} Z`, fill: "#ffffff", "fill-opacity": 0.55 }, glass);

  // Below the screen: wordmark, floppy slot, drive light; knobs on the side.
  el("text", { class: "hairline__label", "font-size": 4, "letter-spacing": 0.8, x: screen.u + 2, y: screen.v + screen.h + 13 }, front).textContent = "responder";
  el("rect", { class: "hairline__edge", height: 4, rx: 2, width: 44, x: screen.u + 70, y: screen.v + screen.h + 9 }, front);
  el("line", { class: "hairline__lo", x1: screen.u + 73, x2: screen.u + 111, y1: screen.v + screen.h + 11, y2: screen.v + screen.h + 11 }, front);
  const driveLight = el("rect", { fill: "#e4e4e0", height: 2, rx: 1, width: 5, x: screen.u + 118, y: screen.v + screen.h + 10 }, front);
  const knobs = rightPlane(M.x1, M.yF, M.z0 + 30, monitor);
  el("circle", { class: "hairline__mid", cx: 8, cy: 6, r: 3.2 }, knobs);
  el("circle", { class: "hairline__mid", cx: 17, cy: 6, r: 3.2 }, knobs);
  el("line", { class: "hairline__mid", x1: 8, x2: 8, y1: 3.4, y2: 5 }, knobs);
  el("line", { class: "hairline__mid", x1: 17, x2: 18, y1: 3.4, y2: 5 }, knobs);

  // Keyboard.
  const K = { x0: 16, x1: 206, y0: 114, y1: 186, z: B.h };
  const rows = [
    Array<number>(15).fill(1),
    [1.5, ...Array<number>(12).fill(1), 1.5],
    [1.75, ...Array<number>(11).fill(1), 2.25],
    [2.25, ...Array<number>(10).fill(1), 2.75],
    [1.5, 1.5, 7, 1.5, 1.5, 2],
  ];
  const keyboard = el("g");
  poly([[K.x0 - 4, K.y0 - 4, K.z], [K.x1 + 4, K.y0 - 4, K.z], [K.x1 + 4, K.y1 + 3, K.z], [K.x0 - 4, K.y1 + 3, K.z]], "hairline__mid", keyboard);
  const unit = (K.x1 - K.x0) / 15;
  const rowDepth = (K.y1 - K.y0) / rows.length;
  type Key = { down: boolean; g: SVGGElement; pressedAt: number; wide: boolean; x0: number; x1: number; y0: number; y1: number };
  const keys: Key[] = [];
  rows.forEach((row, r) => {
    let x = K.x0;
    for (const width of row) {
      keys.push({
        down: false,
        g: el("g", {}, keyboard),
        pressedAt: 0,
        wide: width > 1.4,
        x0: x + 0.9,
        x1: x + width * unit - 0.9,
        y0: K.y0 + r * rowDepth + 0.9,
        y1: K.y0 + (r + 1) * rowDepth - 0.9,
      });
      x += width * unit;
    }
  });
  const drawKey = (key: Key) => {
    key.g.replaceChildren();
    const h = key.down ? 1.6 : 4.2;
    const inset = 1.5;
    const top = { x0: key.x0 + inset, x1: key.x1 - inset, y0: key.y0 + inset * 0.6, y1: key.y1 - inset * 1.2, z: K.z + h };
    poly([[key.x1, key.y0, K.z], [key.x1, key.y1, K.z], [top.x1, top.y1, top.z], [top.x1, top.y0, top.z]], "hairline__lo hairline__fill", key.g);
    poly([[key.x0, key.y1, K.z], [key.x1, key.y1, K.z], [top.x1, top.y1, top.z], [top.x0, top.y1, top.z]], "hairline__lo hairline__fill", key.g);
    poly([[top.x0, top.y0, top.z], [top.x1, top.y0, top.z], [top.x1, top.y1, top.z], [top.x0, top.y1, top.z]], key.down ? "hairline__hi hairline__fill" : "hairline__mid hairline__fill", key.g);
    if (key.wide && !key.down) line([top.x0 + 2, (top.y0 + top.y1) / 2, top.z], [top.x0 + 5, (top.y0 + top.y1) / 2, top.z], "hairline__lo", key.g);
  };
  keys.forEach(drawKey);
  const [ledX, ledY] = P(B.x1 - 10, B.y1 - B.lip - 6, B.h);
  const powerLight = el("circle", { cx: ledX, cy: ledY, fill: "#171715", r: 1.5 });

  // Log lines.
  let clock = 4 * 3600 + 31 * 60 + 2;
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;
  const nextLine = () => {
    const roll = Math.random();
    const level: Level = roll < 0.08 ? "ERR" : roll < 0.24 ? "WRN" : "INF";
    clock += 1 + Math.floor(Math.random() * 3);
    const time = [Math.floor(clock / 3600) % 24, Math.floor(clock / 60) % 60, clock % 60].map((part) => String(part).padStart(2, "0")).join(":");
    return { level, message: pick(messages[level]), service: pick(services).padEnd(8, " "), time };
  };
  type LogLine = { render: () => void; shown: number; text: SVGTextElement; total: number; y: number; level: Level };
  const lines: LogLine[] = [];
  let sequence = 0;
  const addLine = (typed: boolean): LogLine => {
    const data = nextLine();
    const y = T.top + 15 + sequence++ * T.lineHeight;
    const text = el("text", { class: "hairline__mono", "font-size": T.fontSize, x: T.x, y, "xml:space": "preserve" }, logScroll);
    const levelWeight = data.level === "INF" ? 500 : 700;
    const parts: Array<[SVGTSpanElement, string]> = [
      [el("tspan", { fill: "#b5b5b0" }, text), `${data.time} `],
      [el("tspan", { fill: data.level === "INF" ? "#8a8a85" : "#171715", "font-weight": levelWeight }, text), `${data.level} `],
      [el("tspan", { fill: "#8a8a85" }, text), `${data.service} `],
      [el("tspan", { fill: { ERR: "#171715", INF: "#62625d", WRN: "#2b2b28" }[data.level], "font-weight": data.level === "ERR" ? 700 : 400 }, text), data.message],
    ];
    const entry: LogLine = {
      level: data.level,
      render: () => {
        let left = entry.shown;
        for (const [node, value] of parts) {
          node.textContent = value.slice(0, Math.max(0, left));
          left -= value.length;
        }
      },
      shown: 0,
      text,
      total: parts.reduce((count, [, value]) => count + value.length, 0),
      y,
    };
    if (typed) {
      entry.shown = entry.total;
      entry.render();
    }
    lines.push(entry);
    return entry;
  };
  for (let i = 0; i < T.rows; i++) addLine(true);
  let scroll = Math.max(0, (sequence - T.rows) * T.lineHeight);
  let scrollTarget = scroll;
  logScroll.setAttribute("transform", `translate(0 ${-scroll})`);
  const placeCursor = (visible: boolean) => {
    const last = lines.at(-1);
    if (!last) return;
    cursor.setAttribute("x", String(T.x + last.text.getComputedTextLength() + 0.8));
    cursor.setAttribute("y", String(last.y - 3.4 - scroll));
    cursor.setAttribute("opacity", visible ? "1" : "0");
  };

  // Fit the drawing.
  const bounds = svg.getBBox();
  const pad = 14;
  const viewWidth = bounds.width + pad * 2;
  const viewHeight = bounds.height + pad * 2;
  svg.setAttribute("viewBox", `${bounds.x - pad} ${bounds.y - pad} ${viewWidth} ${viewHeight}`);
  svg.setAttribute("width", String(WIDTH));
  svg.setAttribute("height", String(Math.round((viewHeight / viewWidth) * WIDTH)));

  if (!animate) {
    keys[20]!.down = true;
    drawKey(keys[20]!);
    placeCursor(true);
    return () => {};
  }

  let typing: (LogLine & { startedAt: number }) | null = null;
  let nextAt = 0;
  let speed = 1;
  let frame = 0;
  const faster = () => (speed = 1.8);
  const slower = () => (speed = 1);
  svg.addEventListener("pointerenter", faster);
  svg.addEventListener("pointerleave", slower);

  const tick = (now: number) => {
    if (!typing && now >= nextAt) {
      typing = Object.assign(addLine(false), { startedAt: now });
      if (sequence > T.rows) scrollTarget = (sequence - T.rows) * T.lineHeight;
    }
    if (typing) {
      const shown = Math.min(typing.total, Math.floor(((now - typing.startedAt) / 1000) * 70 * speed));
      if (shown !== typing.shown) {
        typing.shown = shown;
        typing.render();
        if (Math.random() < 0.5) {
          const key = pick(keys);
          key.down = true;
          key.pressedAt = now;
          drawKey(key);
        }
        driveLight.setAttribute("fill", Math.random() < 0.6 ? "#171715" : "#e4e4e0");
      }
      if (shown >= typing.total) {
        typing = null;
        nextAt = now + (350 + Math.random() * 900) / speed;
        driveLight.setAttribute("fill", "#e4e4e0");
      }
    }
    for (const key of keys) {
      if (key.down && now - key.pressedAt > 90) {
        key.down = false;
        drawKey(key);
      }
    }
    scroll += (scrollTarget - scroll) * 0.18;
    logScroll.setAttribute("transform", `translate(0 ${(-scroll).toFixed(2)})`);
    while (lines.length > T.rows + 4) lines.shift()!.text.remove();
    placeCursor(typing !== null || Math.floor(now / 500) % 2 === 1);
    sweep.setAttribute("y", (G.v - 20 + ((now % 4200) / 4200) * (G.h + 30)).toFixed(2));
    liveDot.setAttribute("opacity", String(0.55 + 0.45 * Math.sin(now / 300)));
    powerLight.setAttribute("opacity", String(0.75 + 0.25 * Math.sin(now / 700)));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    svg.removeEventListener("pointerenter", faster);
    svg.removeEventListener("pointerleave", slower);
  };
}

export function HairlineComputer({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop = draw(svg, !motion.matches);
    const restart = () => {
      stop();
      stop = draw(svg, !motion.matches);
    };
    motion.addEventListener("change", restart);
    return () => {
      motion.removeEventListener("change", restart);
      stop();
    };
  }, []);
  return <svg aria-label="A computer streaming logs" className={className ? `hairline ${className}` : "hairline"} ref={ref} role="img" />;
}
