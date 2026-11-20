import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/window-apps.css", ["window-apps.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/simulator.js", ["simulator.js", "text/javascript; charset=utf-8"]],
  ["/move-tutorial.js", ["move-tutorial.js", "text/javascript; charset=utf-8"]],
  ["/window-previews.js", ["window-previews.js", "text/javascript; charset=utf-8"]],
  ["/engine.js", ["engine.js", "text/javascript; charset=utf-8"]],
  ["/ktiler-icon.png", ["ktiler-icon.png", "image/png"]],
  ["/kde-icon.png", ["kde-icon.png", "image/png"]],
]);
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);

const server = createServer(async (request, response) => {
  const file = files.get(new URL(request.url, "http://localhost").pathname);
  if (!file || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500);
    response.end("Could not read file");
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Tiling simulator: http://${host}:${port}`));
