import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { siteFiles } from "./site-files.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  const directory = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const file = siteFiles.get(pathname) ?? siteFiles.get(`${directory}index.html`);
  if (!file || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(new URL(file.source, import.meta.url));
    response.writeHead(200, {
      "Content-Type": file.mime,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error.code === "ENOENT" && pathname === "/ktiler.kwinscript") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Build the download for local preview with npm run build:kwin.");
      return;
    }
    response.writeHead(500);
    response.end("Could not read file");
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`ktiler website: http://${host}:${server.address().port}`));
