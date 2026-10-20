import type { SaveImagePayload } from './messages';
import { buildAssetFilename, normalizeDomain } from './model';

export interface ResolvedSaveRequest {
  imageUrl: string;
  sourcePageUrl: string;
  sourceDomain: string;
  filename: string;
}

export function createSavePayload(imageUrl: string, sourcePageUrl: string): SaveImagePayload {
  return {
    imageUrl,
    sourcePageUrl,
    sourceDomain: normalizeDomain(sourcePageUrl)
  };
}

export function resolveSaveRequest(
  payload: SaveImagePayload,
  saveBaseDir: string,
  now?: Date
): ResolvedSaveRequest {
  const sourceDomain = payload.sourceDomain ?? normalizeDomain(payload.sourcePageUrl);

  return {
    imageUrl: payload.imageUrl,
    sourcePageUrl: payload.sourcePageUrl,
    sourceDomain,
    filename: buildAssetFilename({
      imageUrl: payload.imageUrl,
      sourceDomain,
      saveBaseDir,
      now
    })
  };
}
