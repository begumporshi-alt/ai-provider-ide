# App Signing & Auto-updater

## Overview
This guide covers macOS codesigning, notarization, and the auto-updater setup.

## Prerequisites

### 1. Create Developer Certificate (Self-signed for Dev)
```bash
# Create a key pair
openssl genrsa -out dev.key 2048
openssl req -new -x509 -key dev.key -out dev.crt -days 3650 \
  -subj "/C=US/ST=California/L=San Francisco/O=AI Provider IDE/CN=dev.aiprovider.ide"

# Convert to PKCS12 for macOS Keychain
openssl pkcs12 -export -out dev.p12 -inkey dev.key -in dev.crt \
  -passout pass:codesign -name "AI Provider IDE"

# Import to Keychain (you'll be prompted)
security import dev.p12 -k /Library/Keychains/System.keychain -P codesign -T /usr/bin/codesign

# Add trust
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain dev.crt
```

### 2. Set up Environment Variables
Add to your `.zshrc` or `.bash_profile`:
```bash
export TAURI_SIGNING_PRIVATE_KEY=/path/to/dev.key
export TAURI_SIGNING_PUBLIC_KEY=/path/to/dev.pub
```

## Tauri Config

The `tauri.conf.json` now includes:

```json
{
  "updater": {
    "active": true,
    "endpoints": [
      "https://releases.aiprovider.dev/{target}/{arch}/{version}/latest"
    ],
    "pubkey": "",
    "dialog": true
  }
}
```

**Note:** The `pubkey` field is currently empty. You need to:
1. Generate a key pair: `tauri signer generate-keypair`
2. Fill in the public key in `tauri.conf.json`

## Build Commands

### Debug Build
```bash
pnpm build && pnpm run tauri build --debug
```

### Release Build (with signing)
```bash
pnpm build && pnpm run tauri build
```

### Notarization (macOS)
```bash
# Submit to Apple for notarization
xcrun notarytool submit "path/to/Artifact.pkg" \
  --apple-id your@email.com \
  --password app-specific-password \
  --team-id your-team-id

# Staple the notarization
xcrun stapler staple "path/to/Application.app"
```

## Auto-updater Flow

1. **Check for updates:** Tauri periodically checks the endpoint
2. **Download:** New version downloaded in background
3. **Dialog:** User prompted to update
4. **Install:** After acceptance, app restarts and installer runs

### Release Server
You need to host releases at the configured endpoint:

```
https://releases.aiprovider.dev/{target}/{arch}/{version}/latest
```

Example structure:
```
/darwin/aarch64/0.1.0/latest
  ├── AI-Provider IDE.app.tar.gz
  └── latest.json
```

`latest.json` format:
```json
{
  "version": "0.1.1",
  "notes": "Changelog here",
  "pub_date": "2026-09-17T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://releases.aiprovider.dev/darwin/aarch64/0.1.1/AI-Provider IDE.app.tar.gz"
    }
  }
}
```

## Testing

### Local Testing
For local testing, you can use a local server:
```json
"endpoints": ["http://localhost:3000/{target}/{arch}/{version}/latest"]
```

Then run:
```bash
cd releases
python3 -m http.server 3000
```

## Security Notes

- Keep your private key secure and never commit it
- Use a real developer certificate for production
- The update URL should use HTTPS
- The update payload is signed with your private key and verified by the app
