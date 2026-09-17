#!/bin/bash
# release-server.sh - Local auto-updater server for testing
# Run this in the releases/ directory

set -e

PORT=${1:-3000}

echo "Starting local release server on port $PORT..."
echo "Endpoint: http://localhost:$PORT/{target}/{arch}/{version}/latest"
echo ""

# Start Python HTTP server
python3 -m http.server $PORT
