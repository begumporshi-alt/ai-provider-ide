#!/bin/bash
# generate-updater-keys.sh - Generate signing keys for Tauri auto-updater
# Run this once and keep the private key secure

set -e

KEYS_DIR="./signing-keys"
mkdir -p "$KEYS_DIR"

echo "Generating Tauri updater key pair..."

# Generate private key (keep this secret!)
openssl genrsa -out "$KEYS_DIR/private.pem" 2048

# Extract public key
openssl rsa -in "$KEYS_DIR/private.pem" -pubout -out "$KEYS_DIR/public.pem"

echo ""
echo "Keys generated in $KEYS_DIR/"
echo ""
echo "IMPORTANT: Store private.pem securely - NEVER commit to git"
echo ""
echo "To get your public key string for tauri.conf.json:"
echo "  base64 -w 0 < $KEYS_DIR/public.pem"
echo ""
echo "Then add to your .gitignore:"
echo "  $KEYS_DIR/private.pem"
echo "  $KEYS_DIR/"
