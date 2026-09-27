import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";

const portal = spawn(process.execPath, ["plugins/portal/src/index.ts"], {
  stdio: "inherit",
  env: { ...process.env, PORT: "8081" },
});
const server = createServer((req, res) => {
  const upstream = request(
    { hostname: "127.0.0.1", port: 8081, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502);
    res.end("Local portal is starting");
  });
  req.pipe(upstream);
});
server.on("upgrade", (req, socket, head) => {
  const upstream = connect(8081, "127.0.0.1", () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
portal.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    portal.kill(signal);
  });
server.listen(8080, "0.0.0.0");
