// Idempotent patch for vinext 0.0.50 (and 1.0.0-beta.x): StaticFileCache keys
// keep Windows backslashes (path.relative) while request pathnames use forward
// slashes, so every /assets/* lookup misses and static assets 404 in
// `vinext start`. Root-level files (favicon etc.) are unaffected.
// Applied via "postinstall" so local npm installs stay patched.
const fs = require("fs");
const path = require("path");
const target = path.resolve(__dirname, "..", "node_modules", "vinext", "dist", "server", "static-file-cache.js");
if (!fs.existsSync(target)) { console.log("[patch-vinext] target not found, skipping"); process.exit(0); }
let src = fs.readFileSync(target, "utf8");
const needle = 'const pathname = "/" + relativePath;';
const replacement = 'const pathname = "/" + relativePath.replaceAll(path.sep, "/");';
if (src.includes(replacement)) { console.log("[patch-vinext] already patched"); process.exit(0); }
if (!src.includes(needle)) { console.log("[patch-vinext] pattern not found, skipping"); process.exit(0); }
src = src.replace(needle, replacement);
fs.writeFileSync(target, src);
console.log("[patch-vinext] patched static-file-cache.js");
