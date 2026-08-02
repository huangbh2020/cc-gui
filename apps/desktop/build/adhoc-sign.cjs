// Ad-hoc signing for Mcode (macOS only).
//
// Mcode has no paid Apple Developer ID certificate, so electron-builder skips
// macOS signing entirely — its macPackager only signs when it finds a
// "Developer ID Application" cert in the keychain, and osx-sign throws rather
// than falling back to ad-hoc. On macOS 15+ (Sequoia) Gatekeeper then refuses
// to run a fully-unsigned app at all: right-click > Open offers no bypass and
// no "Open Anyway" appears in System Settings.
//
// Signing with the ad-hoc identity ("-") gives Gatekeeper a signature to
// verify, so first launch works via right-click > Open (or System Settings >
// Privacy & Security > Open Anyway). Users still see the "unverified
// developer" dialog once — that's expected without real notarization.
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
