export const REQUEST_ID_HEADER = "x-request-id";

/** Structural match for `IdGenerator` in @sharerepo/domain. */
export interface CorrelationIdSource {
  next(): string;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidCorrelationId(value: string): boolean {
  return SAFE_ID.test(value);
}

/** Reuses a safe incoming `x-request-id`, otherwise generates a new one. */
export function correlationIdFrom(request: Request, ids: CorrelationIdSource): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  return incoming !== null && isValidCorrelationId(incoming) ? incoming : ids.next();
}

/** Returns a response carrying `x-request-id`, cloning it if its headers are immutable. */
export function withCorrelationId(response: Response, correlationId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, correlationId);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(REQUEST_ID_HEADER, correlationId);
    return copy;
  }
}
