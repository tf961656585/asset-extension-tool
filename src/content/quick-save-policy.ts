export const MIN_IMAGE_EDGE = 80;

export interface ImageLike {
  currentSrc?: string;
  src?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
}

export interface EventProbe {
  target: unknown;
  composedPath?: () => unknown[];
}

interface ClosestCapable {
  tagName?: unknown;
  closest?: (selector: string) => unknown;
}

function normalizeTagName(node: unknown): string | null {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const { tagName } = node as ClosestCapable;
  return typeof tagName === 'string' ? tagName.toLowerCase() : null;
}

function isImgTagNode(node: unknown): boolean {
  return normalizeTagName(node) === 'img';
}

function resolveClosestImage(node: unknown): unknown | null {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const { closest } = node as ClosestCapable;
  if (typeof closest !== 'function') {
    return null;
  }

  const candidate = closest.call(node, 'img');
  return isImgTagNode(candidate) ? candidate : null;
}

function getCandidateNodes(probe: EventProbe): unknown[] {
  const path = typeof probe.composedPath === 'function' ? probe.composedPath() : [];
  const nodes = path.slice();
  if (probe.target) {
    nodes.push(probe.target);
  }
  return nodes;
}

export function resolveImageTargetFromProbe(probe: EventProbe): unknown | null {
  const visited = new Set<unknown>();
  for (const node of getCandidateNodes(probe)) {
    if (!node || visited.has(node)) {
      continue;
    }
    visited.add(node);

    if (isImgTagNode(node)) {
      return node;
    }

    const closestImage = resolveClosestImage(node);
    if (closestImage) {
      return closestImage;
    }
  }

  return null;
}

function readEdge(primary: number | undefined, fallback: number | undefined): number {
  const resolved = primary || fallback || 0;
  return Number.isFinite(resolved) ? resolved : 0;
}

export function getImageUrl(image: ImageLike): string {
  return image.currentSrc || image.src || '';
}

export function isSavableImage(image: ImageLike, minEdge = MIN_IMAGE_EDGE): boolean {
  const imageUrl = getImageUrl(image);
  const width = readEdge(image.naturalWidth, image.width);
  const height = readEdge(image.naturalHeight, image.height);
  return Boolean(imageUrl) && !imageUrl.startsWith('data:') && width >= minEdge && height >= minEdge;
}
