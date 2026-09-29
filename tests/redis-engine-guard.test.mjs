import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { resolve } from "node:path";

const script = resolve(import.meta.dirname, "../scripts/qa-redis-engine.mjs");
const pidfile = "/var/tmp/suara-redis-engine-guard-test/redis.pid";
const refused = {
  kind: "local-redis-lua-engine", pass: false,
  error: "Harness failed or local engine identity did not match.", cleanup: false,
};

function run(args) {
  return new Promise((resolveRun, reject) => {
    execFile(process.execPath, [script, ...args], { timeout: 5000, maxBuffer: 16384 }, (error, stdout, stderr) => {
      if (error?.killed) return reject(new Error("Guard check exceeded its deadline."));
      resolveRun({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function assertRefused(args) {
  const result = await run(args);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), refused);
}

test("real-engine harness requires explicit safe local test arguments", async () => {
  for (const args of [
    [], ["--port", "6379", "--pidfile", pidfile],
    ["--port", "1024", "--pidfile", pidfile],
    ["--port", "65536", "--pidfile", pidfile],
    ["--port", "16389", "--pidfile", "relative/redis.pid"],
    ["--port", "16389", "--pidfile", "/var/tmp/test/../redis.pid"],
    ["--port", "16389", "--port", "16390"],
    ["--port", "16389", "--pidfile", pidfile, "--host", "example.com"],
  ]) await assertRefused(args);
});

test("real-engine harness rejects unrelated Redis identity before mutation", async (t) => {
  const requests = [];
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.on("data", bytes => {
      requests.push(bytes.toString("utf8"));
      const wrong = "/var/tmp/unrelated-service/redis.pid";
      socket.write(`*2\r\n$7\r\npidfile\r\n$${Buffer.byteLength(wrong)}\r\n${wrong}\r\n`);
    });
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolveClose => server.close(resolveClose));
  });
  await assertRefused(["--port", String(server.address().port), "--pidfile", pidfile]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "*3\r\n$6\r\nCONFIG\r\n$3\r\nGET\r\n$7\r\npidfile\r\n");
});

test("real-engine harness requires matching directory even when the pidfile string matches", async t => {
  const requests = [];
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.on("data", bytes => {
      const request = bytes.toString("utf8");
      requests.push(request);
      const label = request.endsWith("$7\r\npidfile\r\n") ? "pidfile" : "dir";
      const value = label === "pidfile" ? pidfile : "/var/tmp/unrelated-store";
      socket.write(`*2\r\n$${label.length}\r\n${label}\r\n$${Buffer.byteLength(value)}\r\n${value}\r\n`);
    });
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolveClose => server.close(resolveClose));
  });
  await assertRefused(["--port", String(server.address().port), "--pidfile", pidfile]);
  assert.deepEqual(requests, [
    "*3\r\n$6\r\nCONFIG\r\n$3\r\nGET\r\n$7\r\npidfile\r\n",
    "*3\r\n$6\r\nCONFIG\r\n$3\r\nGET\r\n$3\r\ndir\r\n",
  ]);
});
