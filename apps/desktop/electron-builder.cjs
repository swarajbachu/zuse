const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { parse } = require("yaml");

const config = parse(
	readFileSync(join(__dirname, "electron-builder.base.yml"), "utf8"),
);

// electron-builder combines common and platform-specific `files` lists. That
// selects dist-electron twice on Linux and hard-linking unpacked child scripts
// then fails with EEXIST. Compose one list before passing it to the builder.
if (process.platform === "linux") {
	// FPM derives /opt/<productName> from this top-level value. Chromium's
	// SUID zygote cannot launch from a path containing spaces (Electron #44414).
	// The desktop entry keeps the visible Zuse (Beta) name via linux.desktop.
	config.productName = config.linux.executableName;
	config.files = [...config.files, ...config.linux.files];
	delete config.linux.files;
}

module.exports = config;
