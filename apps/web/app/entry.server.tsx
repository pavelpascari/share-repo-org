import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { logRouteError, requestLogger } from "./error-logging.ts";

/** A thrown `data(...)` value, which React Router renders as an error response. */
const isDataResponse = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { type?: unknown }).type === "DataWithResponseInit";

// React Router's default entry, with errors logged through the request's redacting logger
// instead of `console.error` (which would print raw messages, including SQL parameters).

export const handleError: HandleErrorFunction = (error, { request, context }) => {
  // Aborted requests and deliberate error responses (404, 403, 503) are not failures.
  if (request.signal.aborted || isRouteErrorResponse(error) || isDataResponse(error)) return;
  const logger = requestLogger(context);
  if (logger !== undefined) logRouteError(logger, error);
};

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell. Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          const logger = requestLogger(loadContext);
          if (logger !== undefined) logRouteError(logger, error);
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
