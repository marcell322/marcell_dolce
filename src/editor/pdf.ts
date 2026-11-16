import { colorToCss } from "../common/geom";

const SVG_NS = "http://www.w3.org/2000/svg";
const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const PAGE_GUTTER = 18;

export interface PdfSvgPage {
  svg: SVGSVGElement;
  width: number;
  height: number;
}

interface VerticalBounds {
  top: number;
  bottom: number;
}

interface MeasuredElement extends VerticalBounds {
  element: Element;
}

interface SystemLayout {
  parent: Element;
  root: Element;
  systems: MeasuredElement[];
  otherChildren: MeasuredElement[];
}

interface PageSlice extends VerticalBounds {
  elements: Element[];
}

function yBounds(element: Element, svgRect: DOMRect, height: number): VerticalBounds {
  const rect = element.getBoundingClientRect();
  return {
    top: (rect.top - svgRect.top) * height / svgRect.height,
    bottom: (rect.bottom - svgRect.top) * height / svgRect.height,
  };
}

function measureSystems(svg: SVGSVGElement, width: number, height: number): SystemLayout | null {
  const selector = "[data-pdf-system],.system,.staff-system";
  const sourceSystems = [...svg.querySelectorAll<SVGGraphicsElement>(selector)];
  if (!sourceSystems.length) return null;
  const parent = sourceSystems[0]!.parentNode as Element | null;
  if (!parent || sourceSystems.some((system) => system.parentNode !== parent)) return null;

  let probe = svg;
  let removeProbe = false;
  let svgRect = probe.getBoundingClientRect();
  if (!(svgRect.width > 0 && svgRect.height > 0)) {
    probe = svg.cloneNode(true) as SVGSVGElement;
    probe.setAttribute("width", `${width}px`);
    probe.setAttribute("height", `${height}px`);
    probe.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    removeProbe = true;
    svgRect = probe.getBoundingClientRect();
  }

  try {
    if (!(svgRect.width > 0 && svgRect.height > 0)) return null;
    const probeSystems = [...probe.querySelectorAll<SVGGraphicsElement>(selector)];
    const probeParent = probeSystems[0]?.parentNode as Element | null;
    if (probeSystems.length !== sourceSystems.length || !probeParent || probeParent.children.length !== parent.children.length) return null;

    const sourceChildren = [...parent.children];
    const probeChildren = [...probeParent.children];
    const systemSet = new Set<Element>(sourceSystems);
    const systems = sourceSystems.map((element, index) => ({
      element,
      ...yBounds(probeSystems[index]!, svgRect, height),
    })).sort((a, b) => a.top - b.top);
    const otherChildren = sourceChildren
      .filter((element) => !systemSet.has(element))
      .map((element) => ({
        element,
        ...yBounds(probeChildren[sourceChildren.indexOf(element)]!, svgRect, height),
      }));

    let root = parent;
    while (root.parentNode && root.parentNode !== svg) root = root.parentNode as Element;
    if (root.parentNode !== svg) return null;
    return { parent, root, systems, otherChildren };
  } finally {
    if (removeProbe) probe.remove();
  }
}

function splitAtSystems(systems: readonly MeasuredElement[], capacity: number): PageSlice[] {
  const slices: PageSlice[] = [];
  let elements: Element[] = [];
  let top = 0;
  let bottom = 0;

  for (const system of systems) {
    const pageTop = elements.length ? top : slices.length === 0 ? 0 : system.top;
    if (elements.length && system.bottom - pageTop > capacity) {
      slices.push({ top: pageTop, bottom, elements });
      elements = [];
    }
    if (!elements.length) top = slices.length === 0 ? 0 : system.top;
    elements.push(system.element);
    bottom = Math.max(bottom, system.bottom);
  }
  if (elements.length) slices.push({ top, bottom, elements });
  return slices;
}

function assignOtherChildren(
  slices: PageSlice[],
  children: readonly MeasuredElement[],
  systems: readonly MeasuredElement[],
): void {
  const firstSystem = systems[0]!;
  const lastSystem = systems[systems.length - 1]!;
  const starts = slices.map((slice) => systems.find((system) => system.element === slice.elements[0])!.top);

  for (const child of children) {
    const center = (child.top + child.bottom) / 2;
    let pageIndex = 0;
    if (center > lastSystem.bottom) pageIndex = slices.length - 1;
    else if (center >= firstSystem.top) {
      let distance = Number.POSITIVE_INFINITY;
      starts.forEach((start, index) => {
        const d = Math.abs(center - start);
        if (d < distance) {
          distance = d;
          pageIndex = index;
        }
      });
    }
    const slice = slices[pageIndex]!;
    slice.elements.push(child.element);
  }
}

function svgViewBox(svg: SVGSVGElement): { x: number; y: number } {
  const parts = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  return parts?.length === 4 && parts.every(Number.isFinite)
    ? { x: parts[0]!, y: parts[1]! }
    : { x: 0, y: 0 };
}

function backgroundRect(width: number, height: number, color: number): SVGRectElement | null {
  if (((color >>> 0) & 0xffffff) === 0xffffff) return null;
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
  rect.setAttribute("fill", colorToCss(color));
  return rect;
}

function cloneSystemContent(
  svg: SVGSVGElement,
  layout: SystemLayout,
  elements: readonly Element[],
): Element {
  let node = layout.parent.cloneNode(false) as Element;
  for (const element of elements) node.append(element.cloneNode(true));

  let ancestor = layout.parent.parentNode as Element | null;
  while (ancestor && ancestor !== svg) {
    const wrapper = ancestor.cloneNode(false) as Element;
    wrapper.append(node);
    node = wrapper;
    ancestor = ancestor.parentNode as Element | null;
  }
  return node;
}

/** Repackages the rendered SVG into A4 pages without rasterizing its artwork. */
export function pdfPagesOfSvg(
  svg: SVGSVGElement,
  width: number,
  height: number,
  bgColor: number,
  ptPerUnit = 1,
): PdfSvgPage[] {
  if (!Number.isFinite(ptPerUnit) || ptPerUnit <= 0) throw new RangeError("Invalid SVG point scale");
  const paper = width > height ? A4_LANDSCAPE : A4_PORTRAIT;
  const systemLayout = measureSystems(svg, width, height);
  const systems = systemLayout?.systems ?? [];
  const availableHeight = paper.height - PAGE_GUTTER * 2;
  const maxSystemHeight = systems.reduce((max, system) => Math.max(max, system.bottom - system.top), 0);
  const firstSystemBottom = systems[0]?.bottom ?? height;
  const scale = Math.min(
    1,
    paper.width / (width * ptPerUnit),
    availableHeight / (Math.max(maxSystemHeight, firstSystemBottom) * ptPerUnit),
  );
  const scalePt = scale * ptPerUnit;
  const capacity = availableHeight / scalePt;
  const slices = systemLayout
    ? splitAtSystems(systems, capacity)
    : [{ top: 0, bottom: height, elements: [...svg.children] }];
  if (systemLayout) assignOtherChildren(slices, systemLayout.otherChildren, systems);
  const viewBox = svgViewBox(svg);

  return slices.map(({ top, elements }) => {
    const page = document.createElementNS(SVG_NS, "svg");
    page.setAttribute("xmlns", SVG_NS);
    page.setAttribute("viewBox", `0 0 ${paper.width} ${paper.height}`);
    page.setAttribute("width", `${paper.width}pt`);
    page.setAttribute("height", `${paper.height}pt`);

    const content = document.createElementNS(SVG_NS, "g");
    const dx = (paper.width - width * scalePt) / 2;
    content.setAttribute(
      "transform",
      `translate(${dx} ${PAGE_GUTTER}) scale(${scalePt}) translate(${-viewBox.x} ${-(viewBox.y + top)})`,
    );
    if (systemLayout) {
      const selectedRoot = cloneSystemContent(svg, systemLayout, elements);
      content.append(selectedRoot);
      for (const child of [...svg.childNodes]) {
        if (child !== systemLayout.root) page.append(child.cloneNode(true));
      }
    } else {
      for (const child of [...svg.childNodes]) content.append(child.cloneNode(true));
    }

    const background = backgroundRect(paper.width, paper.height, bgColor);
    if (background) page.appendChild(background);
    page.appendChild(content);
    return { svg: page, width: paper.width, height: paper.height };
  });
}
