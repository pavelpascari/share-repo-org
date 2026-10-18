export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {},
} satisfies ExportedHandler<Env>;
