// Ad-hoc signing for Mcode (macOS only).
//
// Mcode has no paid Apple Developer ID certificate, so electron-builder skips
// macOS signing entirely — its macPackager only signs when it finds a
// "Developer ID Application" cert in the keychain, and osx-sign throws rather
// than falling back to ad-hoc. On macOS 15+ (Sequoia) Gatekeeper then refuses
// to run a fully-unsigned app at all: no bypass is offered.
//
// Signing with the ad-hoc identity ("-") gives Gatekeeper a signature to
// verify. With a signature, the quarantine attribute (set on browser-downloaded
// apps) is what blocks launch — removing it lets the app open normally:
//
//   xattr -dr com.apple.quarantine /Applications/Mcode.app
//
// Or use System Settings > Privacy & Security > Open Anyway (the only GUI
// bypass on macOS 26+; right-click > Open no longer works there). Homebrew
// casks strip quarantine at install time, so `brew install --cask mcode` opens
// without any of this.
//
// Wired up through electron-builder's `mac.sign` option (electron-builder.yml);
// electron-builder calls this with the osx-sign opts, where opts.app is the
// path to the assembled .app bundle (before the dmg/zip is built).
const { execFileSync } = require("node:child_process");

module.exports = async function adhocSign(opts) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", opts.app], {
    stdio: "inherit",
  });
};
