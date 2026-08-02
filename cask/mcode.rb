# typed: strict
# frozen_string_literal: true

# Mcode — Homebrew cask
#
# Distributes the GitHub Release DMGs (Mcode-vX.Y.Z-arm64.dmg / Mcode-vX.Y.Z.dmg)
# without the Gatekeeper "unverified developer" warning: brew strips the
# com.apple.quarantine attribute, so no first-launch right-click > Open dance.
#
# Where it lives:
#   - Self-hosted tap (recommended): put this file at `Casks/mcode.rb` in a
#     new repo named `huangbh2020/homebrew-mcode`, then:
#         brew tap huangbh2020/mcode
#         brew install --cask mcode
#   - Official homebrew-cask: the same content goes to `Casks/m/mcode.rb`
#     in a PR to github.com/Homebrew/homebrew-cask.
#
# Per release, bump `version` + both `sha256` values (see README or the repo
# release notes for the one-liner that refreshes them):
#   curl -sL -o /tmp/m.dmg <dmg-url> && shasum -a 256 /tmp/m.dmg
#
# NOTE: do NOT set `auto_updates true` — Mcode's electron-updater can't verify
# its ad-hoc signature, so brew is the actual update channel on macOS.

cask "mcode" do
  version "0.1.13"

  on_arm do
    sha256 "e3a409da8eb6a51addfb316386f8c2e96d70d48288b0ceeaac5a52128a75d12a"

    url "https://github.com/huangbh2020/mcode/releases/download/v#{version}/Mcode-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "c901fcd43629b89ec921bd079504daebcf74d9be5edb2765facde14139f82740"

    url "https://github.com/huangbh2020/mcode/releases/download/v#{version}/Mcode-#{version}.dmg"
  end

  name "Mcode"
  desc "Desktop GUI for the Claude Agent SDK (my Code)"
  homepage "https://github.com/huangbh2020/mcode"

  app "Mcode.app"

  # userData is `~/Library/Application Support/@mcode/desktop` (Electron uses
  # the package.json `name`, not the productName). Contains the sql.js session
  # DB (claude-gui.db) + logs.
  zap trash: [
    "~/Library/Application Support/@mcode",
    "~/Library/Preferences/com.huangbh.mcode.plist",
    "~/Library/Saved Application State/com.huangbh.mcode.savedState",
  ]
end
