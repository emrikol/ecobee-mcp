import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

interface CpuNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface CpuProfile {
  nodes: CpuNode[];
  samples: number[];
  timeDeltas?: number[];
}

interface HeapNode {
  callFrame: CallFrame;
  selfSize: number;
  children?: HeapNode[];
}

interface HeapProfile {
  head: HeapNode;
}

interface FlameNode {
  name: string;
  value: number;
  children: Map<string, FlameNode>;
}

const label = process.argv[2] ?? "profile";
const directory = process.env.PERF_PROFILE_DIR ?? ".artifacts/performance";
const cpu = JSON.parse(
  await readFile(`${directory}/${label}.cpuprofile`, "utf8"),
) as CpuProfile;
const heap = JSON.parse(
  await readFile(`${directory}/${label}.heapprofile`, "utf8"),
) as HeapProfile;

const analysis = {
  label,
  totalCpuMs: round(
    (cpu.timeDeltas ?? cpu.samples.map(() => 1_000)).reduce(
      (total, value) => total + value,
      0,
    ) / 1_000,
  ),
  topCpuSelf: topCpuFrames(cpu, 30),
  topAllocations: topHeapFrames(heap, 30),
};

await writeFile(
  `${directory}/${label}-analysis.json`,
  `${JSON.stringify(analysis, null, 2)}\n`,
);
await writeFile(
  `${directory}/${label}-flamegraph.svg`,
  renderFlamegraph(cpu, label),
);
console.log(JSON.stringify(analysis, null, 2));

function topCpuFrames(
  profile: CpuProfile,
  limit: number,
): Array<{ frame: string; selfMs: number; percent: number }> {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  let total = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const duration = profile.timeDeltas?.[index] ?? 1_000;
    const node = nodes.get(profile.samples[index]);
    if (!node) continue;
    const name = frameName(node.callFrame);
    totals.set(name, (totals.get(name) ?? 0) + duration);
    total += duration;
  }
  return [...totals]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([frame, microseconds]) => ({
      frame,
      selfMs: round(microseconds / 1_000),
      percent: round((microseconds / total) * 100),
    }));
}

function topHeapFrames(
  profile: HeapProfile,
  limit: number,
): Array<{ frame: string; sampledMiB: number }> {
  const totals = new Map<string, number>();
  const visit = (node: HeapNode) => {
    const name = frameName(node.callFrame);
    totals.set(name, (totals.get(name) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile.head);
  return [...totals]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([frame, bytes]) => ({
      frame,
      sampledMiB: round(bytes / 1024 / 1024),
    }));
}

function renderFlamegraph(profile: CpuProfile, label: string): string {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const root: FlameNode = { name: "all", value: 0, children: new Map() };
  for (let index = 0; index < profile.samples.length; index++) {
    const duration = profile.timeDeltas?.[index] ?? 1_000;
    const stack: string[] = [];
    let current = profile.samples[index];
    while (nodes.has(current)) {
      const node = nodes.get(current)!;
      stack.push(frameName(node.callFrame));
      const parent = parents.get(current);
      if (parent === undefined) break;
      current = parent;
    }
    stack.reverse();
    root.value += duration;
    let flameNode = root;
    for (const name of stack) {
      let child = flameNode.children.get(name);
      if (!child) {
        child = { name, value: 0, children: new Map() };
        flameNode.children.set(name, child);
      }
      child.value += duration;
      flameNode = child;
    }
  }

  const width = 1_600;
  const margin = 16;
  const header = 52;
  const frameHeight = 18;
  const depth = maxDepth(root);
  const height = header + (depth + 1) * frameHeight + margin;
  const rectangles: string[] = [];
  renderFlameNode(
    root,
    margin,
    width - margin * 2,
    0,
    depth,
    header,
    frameHeight,
    root.value,
    rectangles,
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;fill:#18181b}.title{font-family:system-ui,sans-serif;font-size:18px;font-weight:600}.subtitle{font-family:system-ui,sans-serif;font-size:12px;fill:#52525b}rect{stroke:#fff;stroke-width:.5}</style>`,
    `<rect width="100%" height="100%" fill="#fafafa"/>`,
    `<text x="${margin}" y="24" class="title">${escapeXml(label)} CPU flamegraph</text>`,
    `<text x="${margin}" y="43" class="subtitle">${round(root.value / 1_000)} ms sampled; width is inclusive CPU time</text>`,
    ...rectangles,
    `</svg>`,
    "",
  ].join("\n");
}

function renderFlameNode(
  node: FlameNode,
  x: number,
  width: number,
  depth: number,
  max: number,
  header: number,
  frameHeight: number,
  total: number,
  output: string[],
): void {
  if (width < 0.5) return;
  const y = header + (max - depth) * frameHeight;
  const label = `${node.name} (${round(node.value / 1_000)} ms, ${round((node.value / total) * 100)}%)`;
  output.push(
    `<g><title>${escapeXml(label)}</title><rect x="${round(x)}" y="${y}" width="${round(width)}" height="${frameHeight - 1}" rx="1" fill="${frameColor(node.name)}"/><text x="${round(x + 3)}" y="${y + 12}">${escapeXml(clipLabel(node.name, width))}</text></g>`,
  );

  let childX = x;
  for (const child of [...node.children.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childWidth = width * (child.value / node.value);
    renderFlameNode(
      child,
      childX,
      childWidth,
      depth + 1,
      max,
      header,
      frameHeight,
      total,
      output,
    );
    childX += childWidth;
  }
}

function maxDepth(node: FlameNode): number {
  let depth = 0;
  for (const child of node.children.values()) {
    depth = Math.max(depth, 1 + maxDepth(child));
  }
  return depth;
}

function frameName(frame: CallFrame): string {
  const fn = frame.functionName || "(anonymous)";
  if (!frame.url) return fn;
  return `${fn} — ${basename(frame.url)}:${frame.lineNumber + 1}`;
}

function frameColor(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const hue = 8 + (hash % 42);
  const lightness = 62 + (hash % 16);
  return `hsl(${hue} 85% ${lightness}%)`;
}

function clipLabel(value: string, width: number): string {
  const characters = Math.max(0, Math.floor((width - 6) / 6.6));
  if (characters < 3) return "";
  return value.length <= characters
    ? value
    : `${value.slice(0, characters - 1)}…`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
