#!/bin/bash
# Build the Claude Proxy headless GUI app
# Compile Swift → app bundle → install launchd plist

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/.local/share/claude-proxy"
BINARY="$APP_DIR/claude-proxy"

mkdir -p "$APP_DIR"

# Only recompile if source changed (prevents Keychain trust invalidation)
SOURCE_HASH=$(shasum "$DIR/main.swift" | cut -d' ' -f1)
BUILT_HASH=""
[ -f "$APP_DIR/.source_hash" ] && BUILT_HASH=$(cat "$APP_DIR/.source_hash")

if [ "$SOURCE_HASH" != "$BUILT_HASH" ] || [ ! -f "$BINARY" ]; then
  echo "Compiling claude-proxy (source changed)..."
  swiftc "$DIR/main.swift" -o "$BINARY" -framework Cocoa -O
  codesign --force --sign - "$BINARY" 2>/dev/null
  xattr -d com.apple.quarantine "$BINARY" 2>/dev/null || true
  xattr -d com.apple.quarantine "$BINARY" 2>/dev/null || true
  echo "$SOURCE_HASH" > "$APP_DIR/.source_hash"
  echo "Binary rebuilt, signed, quarantine removed"
else
  echo "claude-proxy binary unchanged — skipping recompile (preserves Keychain trust)"
fi

echo "Creating launchd plist..."
cat > "$HOME/Library/LaunchAgents/com.prime.claude-proxy.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.prime.claude-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BINARY</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$HOME/.prime/logs/claude-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.prime/logs/claude-proxy-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

echo "Loading launchd agent..."
launchctl unload "$HOME/Library/LaunchAgents/com.prime.claude-proxy.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.prime.claude-proxy.plist"

# Verify. The listener is only created in applicationDidFinishLaunching, so it is
# unreachable until NSApplication finishes its GUI launch handshake — measured at
# ~6s, three times the 2s this check used to sleep, so every successful rebuild
# reported a false failure. ThrottleInterval is 30s, so leave room for a respawn too.
echo "Waiting for proxy to answer /health..."
SECONDS=0
while [ $SECONDS -lt 60 ]; do
  if curl -s --max-time 2 http://127.0.0.1:3211/health | grep -q ok; then
    echo "✓ claude-proxy is running on http://localhost:3211 (ready after ${SECONDS}s)"
    exit 0
  fi
  sleep 1
done

echo "✗ No answer on http://localhost:3211/health after 60s."
echo "  claude-proxy-error.log is normally empty — the proxy's stdout is block-buffered"
echo "  and never flushed, so it stays empty even on a healthy run."
echo "  Check instead: launchctl print gui/\$(id -u)/com.prime.claude-proxy | grep -E 'state|runs|last exit'"
exit 1
