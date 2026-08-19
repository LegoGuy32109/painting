const publicFile = (path: string) =>
  new URL(`../../public/${path}`, import.meta.url);
const clientFile = (path: string) => new URL(`../client/${path}`, import.meta.url);

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api") {
    return Response.json({
      message: "Hello, world!",
      time: new Date().toISOString(),
    });
  }
  if (url.pathname === "/datastar.js") {
    const ds = await Deno.readTextFile(publicFile("datastar.js"));
    return new Response(ds, {
      headers: { "content-type": "application/javascript" },
    });
  }

  if (url.pathname === "/style.css") {
    const css = await Deno.readTextFile(publicFile("style.css"));
    return new Response(css, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }

  if (
    url.pathname === "/app.js" || url.pathname === "/paint-engine.js" ||
    url.pathname === "/palette-engine.js"
  ) {
    const source = await Deno.readTextFile(clientFile(url.pathname.slice(1)));
    return new Response(source, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  if (url.pathname === "/Minecraftia-Regular.ttf") {
    const font = await Deno.readFile(publicFile("Minecraftia-Regular.ttf"));
    return new Response(font, {
      headers: {
        "content-type": "font/ttf",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (url.pathname === "/update") {
    return new Response(`<div id="output">Hello from server land 😲</div>`, {
      headers: { "content-type": "text/html" },
    });
  }

  const html = await Deno.readTextFile(publicFile("index.html"));

  return new Response(html, {
    headers: { "content-type": "text/html" },
  });
}

if (import.meta.main) {
  Deno.serve(handler);
}
