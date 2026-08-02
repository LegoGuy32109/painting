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

  if (url.pathname === "/style.css") {
    const css = await Deno.readTextFile("./style.css");
    return new Response(css, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }

  if (url.pathname === "/app.js" || url.pathname === "/paint-engine.js") {
    const source = await Deno.readTextFile(`.${url.pathname}`);
    return new Response(source, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  if (url.pathname === "/Minecraftia-Regular.ttf") {
    const font = await Deno.readFile("./Minecraftia-Regular.ttf");
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

  const html = await Deno.readTextFile("./index.html");

  return new Response(html, {
    headers: { "content-type": "text/html" },
  });
}

if (import.meta.main) {
  Deno.serve(handler);
}
