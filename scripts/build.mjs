import { build } from "esbuild";
import fs from "node:fs";
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["frontend/login.js", "frontend/desktop.js"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: "dist",
  minify: true,
  metafile: true,
  legalComments: "linked",
}).then((r) =>
  fs.writeFileSync("dist/build-meta.json", JSON.stringify(r.metafile)),
);
fs.copyFileSync("frontend/index.html", "dist/index.html");
fs.copyFileSync("frontend/login.css", "dist/login.css");

fs.cpSync("frontend/wallpapers", "dist/wallpapers", { recursive: true });
