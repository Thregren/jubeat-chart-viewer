// electron-builder 配置。
//
// 默认**把 site/（含全部音乐，约 2.9 GB）打进包里**，装上就能直接听；
// 打包前需要先跑过 python3 tools/build_site.py。
// 如果想做「不带曲库」的轻量包（约 100 MB，首次启动自己选 site 目录）：
//     NO_SITE=1 npm run dist:mac
const path = require("node:path");
const fs = require("node:fs");

const bundleSite = process.env.NO_SITE !== "1";
const siteDir = path.resolve(__dirname, "..", "site");

const extraResources = [{ from: "../docs/README-electron.txt", to: "README-electron.txt" }];
if (bundleSite) {
  if (!fs.existsSync(path.join(siteDir, "index.html"))) {
    throw new Error("BUNDLE_SITE=1 但找不到 ../site：先跑 python3 tools/build_site.py");
  }
  extraResources.push({ from: "../site", to: "site", filter: ["**/*"] });
}

module.exports = {
  appId: "com.thregren.jubeat.viewer",
  productName: "jubeatViewer",
  directories: { output: "dist", buildResources: "build" },
  files: ["main.js", "site-server.js", "package.json"],
  extraResources,
  asar: true,
  mac: {
    category: "public.app-category.music",
    identity: null,
    // 带上曲库之后每个包 2.9 GB，dmg 会再做一份拷贝，这里只出 zip
    target: [{ target: "zip", arch: ["x64", "arm64"] }],
  },
  win: {
    target: [{ target: "zip", arch: ["x64", "arm64"] }],
  },
  linux: {
    category: "AudioVideo",
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
  },
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  compression: "normal",
};
