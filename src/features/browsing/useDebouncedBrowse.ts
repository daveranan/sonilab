import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowseProvider } from "./dbBrowseProvider";
import type { BrowseRequest, BrowseResponse, SearchQuery } from "./browseTypes";
import { LatestBrowseResponseGate } from "./mockBrowseProvider";

const maxResponseCacheEntries = 24;

type DebouncedBrowseOptions = {
  provider: BrowseProvider;
  viewId: string;
  query: SearchQuery;
  folderId?: string;
  collectionId?: string;
  limit: number;
  debounceMs?: number;
  enabled?: boolean;
};

type BrowseExecutionOptions = {
  skipCache?: boolean;
};

export function useDebouncedBrowse({
  provider,
  viewId,
  query,
  folderId,
  collectionId,
  limit,
  debounceMs = 140,
  enabled = true,
}: DebouncedBrowseOptions): {
  response: BrowseResponse | null;
  loading: boolean;
  executeNow: (options?: BrowseExecutionOptions) => void;
  removeRowsById: (rowIds: Iterable<string>) => void;
} {
  const [response, setResponse] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const gateRef = useRef(new LatestBrowseResponseGate());
  const requestCounter = useRef(0);
  const responseCacheRef = useRef(new Map<string, BrowseResponse>());

  const makeRequest = useCallback((): BrowseRequest => {
    requestCounter.current += 1;
    return {
      requestId: `browse-${requestCounter.current}`,
      viewId,
      sourceScope: query.sourceScope,
      folderId,
      collectionId,
      query,
      sort: query.sort,
      limit,
    };
  }, [collectionId, folderId, limit, query, viewId]);

  const execute = useCallback(
    (nextRequest: BrowseRequest, options: BrowseExecutionOptions = {}) => {
      const cacheKey = browseRequestCacheKey(nextRequest);
      if (options.skipCache) {
        responseCacheRef.current.clear();
      }
      const cached = responseCacheRef.current.get(cacheKey);
      if (cached && !options.skipCache) {
        gateRef.current.begin(nextRequest.requestId);
        setResponse({ ...cached, requestId: nextRequest.requestId });
        setLoading(false);
        return;
      }

      gateRef.current.begin(nextRequest.requestId);
      setLoading(true);
      void provider.browse(nextRequest).then((nextResponse) => {
        if (!gateRef.current.accept(nextResponse)) return;
        if (nextResponse.rows.length > 0) {
          rememberResponse(responseCacheRef.current, cacheKey, nextResponse);
        }
        setResponse(nextResponse);
        setLoading(false);
      });
    },
    [provider],
  );

  const removeRowsById = useCallback((rowIds: Iterable<string>) => {
    const ids = new Set(rowIds);
    if (ids.size === 0) return;
    responseCacheRef.current.clear();
    setResponse((current) => {
      if (!current) return current;
      const rows = current.rows.filter((row) => !ids.has(row.id));
      const removedCount = current.rows.length - rows.length;
      if (removedCount === 0) return current;
      return {
        ...current,
        rows,
        totalCount: Math.max(0, current.totalCount - removedCount),
      };
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      gateRef.current.begin("browse-disabled");
      return;
    }
    const request = makeRequest();
    const handle = globalThis.setTimeout(() => execute(request), debounceMs);
    return () => globalThis.clearTimeout(handle);
  }, [debounceMs, enabled, execute, makeRequest]);

  const executeNow = useCallback(
    (options?: BrowseExecutionOptions) => {
      if (!enabled) return;
      execute(makeRequest(), options);
    },
    [enabled, execute, makeRequest],
  );

  return {
    response: enabled ? response : null,
    loading: enabled ? loading : false,
    executeNow,
    removeRowsById,
  };
}

function rememberResponse(
  cache: Map<string, BrowseResponse>,
  key: string,
  response: BrowseResponse,
): void {
  if (cache.size >= maxResponseCacheEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, response);
}

function browseRequestCacheKey(request: BrowseRequest): string {
  return JSON.stringify({
    viewId: request.viewId,
    sourceScope: request.sourceScope,
    folderId: request.folderId ?? "",
    collectionId: request.collectionId ?? "",
    query: request.query,
    sort: request.sort,
    cursor: request.cursor ?? "",
    limit: request.limit,
  });
}
