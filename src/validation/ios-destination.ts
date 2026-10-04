const DEFAULT_IOS_DESTINATION = "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2";

// Layer 2 builds and artifact discovery must use the same destination so
// showBuildSettings sees the SDK/configuration that `xcodebuild build` used.
export function iosSimulatorDestination(): string {
  return process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'] || DEFAULT_IOS_DESTINATION;
}
