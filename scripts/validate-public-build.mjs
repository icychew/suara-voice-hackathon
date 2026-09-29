import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const distRoot = resolve("dist-public");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".xml"]);
const banned = [
  [/(^|["'`(])\/api\//i, "private API path"],
  [/localhost/i, "localhost reference"],
  [/127\.0\.0\.1/i, "loopback reference"],
  [/suara_pipeline/i, "private package reference"],
  [/<form\b/i, "writable form"],
  [/<input\b/i, "writable input"],
  [/<textarea\b/i, "writable textarea"],
  [/\bfetch\s*\(/i, "network fetch"],
  [/\bXMLHttpRequest\b/i, "XHR client"],
  [/\bWebSocket\b/i, "WebSocket client"],
  [/\bgetUserMedia\s*\(/i, "microphone or camera capture"],
  [/\bAudioWorkletProcessor\b/i, "audio worklet processor"],
  [/\bregisterProcessor\s*\(/i, "audio worklet registration"],
  [/\.audioWorklet\.addModule\s*\(/i, "audio worklet client"],
  [/\blocalStorage\b/i, "persistent local storage"],
  [/\bsessionStorage\b/i, "persistent session storage"],
  [/\bindexedDB\b/i, "persistent indexed database"],
  [/mediaDevices/i, "microphone or camera client"],
  [/showOpenFilePicker/i, "file picker client"],
  [/\bFileReader\b/i, "file reader client"],
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

const files = await walk(distRoot);
const failures = [];

for (const path of files.filter((file) => textExtensions.has(extname(file)))) {
  const content = await readFile(path, "utf8");
  for (const [pattern, label] of banned) {
    if (pattern.test(content)) failures.push(`${label}: ${path}`);
  }
}

for (const required of ["index.html", "prototype/index.html", "robots.txt", "sitemap.xml", "assets/hero-family-album.webp"]) {
  const path = join(distRoot, required);
  try {
    await stat(path);
  } catch {
    failures.push(`missing required public artifact: ${path}`);
  }
}

for (const forbidden of ["voice/index.html", "pcm-processor.js"]) {
  const path = join(distRoot, forbidden);
  try {
    await stat(path);
    failures.push(`forbidden public artifact: ${path}`);
  } catch {
    // The public build must not expose voice-only entrypoints or audio workers.
  }
}

if (failures.length) {
  console.error("Public boundary validation failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Public boundary validation passed across ${files.length} built files.`);
