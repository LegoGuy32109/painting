export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api") {
    return Response.json({
      message: "Hello, world!",
      time: new Date().toISOString(),
    });
  }
  if (url.pathname === "/datastar.js") {
    const ds = await Deno.readTextFile("./datastar.js");
    return new Response(ds, {
      headers: { "content-type": "application/javascript" },
    });
  }

  if (url.pathname === "/update") {
    return new Response(`<div id="output">Hello from server land 😲</div>`, {
      headers: { "content-type": "text/html" },
    });
  }

  const html = await Deno.readTextFile("./index.html");

  return new Response(html, {
    headers: { "content-type": "text/html" },
  });
}

if (import.meta.main) {
  Deno.serve(handler);
}
