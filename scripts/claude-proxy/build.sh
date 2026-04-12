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
  xattr -d com.apple.quarantine "$BINARY" 2>/dev/null
  xattr -d com.apple.quarantine "$BINARY" 2>/dev/null
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

sleep 2

# Verify
if curl -s http://localhost:3211/health | grep -q ok; then
  echo "✓ claude-proxy is running on http://localhost:3211"
else
  echo "✗ Failed to start. Check ~/.prime/logs/claude-proxy-error.log"
fi
