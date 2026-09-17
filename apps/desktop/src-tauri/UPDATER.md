# Updater Setup

This directory contains the configuration and scripts for the Tauri auto-updater.

## Quick Start

### 1. Generate Key Pair (One-time setup)
```bash
cd apps/desktop/src-tauri
./generate-updater-keys.sh
```

This creates `signing-keys/` with:
- `private.pem` - Keep secret, never commit
- `public.pem` - Add to `tauri.conf.json`

### 2. Configure tauri.conf.json
Copy the public key:
```bash
base64 -w 0 < signing-keys/public.pem
```

Paste the output into `tauri.conf.json`:
```json
"updater": {
  "active": true,
  "pubkey": "YOUR_BASE64_PUBLIC_KEY_HERE"
}
```

### 3. Local Testing
```bash
# Start local release server
cd apps/desktop/src-tauri
./release-server.sh 3000

# In another terminal, build and test
cd apps/desktop
pnpm build
pnpm run tauri build --debug
```

### 4. Production Release
For production, you'll need:
- [ ] Real Apple Developer certificate (for notarization)
- [ ] HTTPS endpoint for releases
- [ ] Properly signed and notarized builds

See `SIGNING.md` for details.
