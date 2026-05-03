import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Some dev machines have a stale `adb` shadowing the modern one on PATH —
// the canonical case is /Users/<u>/.apportable/SDK/bin/adb, an i386 binary
// from 2014 that fails to exec on Apple Silicon with "Unknown system error
// -86". Resolve to a known-good adb instead of trusting PATH order:
//
//   1. $ANDROID_HOME/platform-tools/adb           (canonical env var)
//   2. $ANDROID_SDK_ROOT/platform-tools/adb       (legacy spelling)
//   3. ~/Library/Android/sdk/platform-tools/adb   (Android Studio default on macOS)
//   4. /Applications/android-sdk-macosx/platform-tools/adb  (older macOS standalone install)
//   5. /opt/homebrew/bin/adb                      (Homebrew on Apple Silicon)
//   6. /usr/local/bin/adb                         (Homebrew on Intel)
//   7. "adb"                                      (fall back to PATH lookup)
export function resolveAdbPath(): string {
  const candidates = [
    process.env['ANDROID_HOME'] ? join(process.env['ANDROID_HOME'], "platform-tools", "adb") : null,
    process.env['ANDROID_SDK_ROOT'] ? join(process.env['ANDROID_SDK_ROOT'], "platform-tools", "adb") : null,
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    "/Applications/android-sdk-macosx/platform-tools/adb",
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "adb";
}
