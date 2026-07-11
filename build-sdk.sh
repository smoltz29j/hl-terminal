#!/bin/bash
# metamask-sdk.bundle.js を生成する。
# MetaMask SDK は ConsenSys の独自ライセンス（再配布不可）のため、
# バンドル成果物はリポジトリに含めず、各自 npm から取得して生成する。
set -e
cd "$(dirname "$0")"
mkdir -p .sdk-build
cd .sdk-build
[ -f package.json ] || echo '{}' > package.json
npm install --no-fund --no-audit @metamask/sdk@0.34.0 esbuild
cat > entry.js <<'EOF'
import { MetaMaskSDK } from "@metamask/sdk";
window.MetaMaskSDK = { MetaMaskSDK };
EOF
npx esbuild entry.js --bundle --minify --format=iife --platform=browser \
  --outfile=../metamask-sdk.bundle.js
echo "OK: metamask-sdk.bundle.js を生成しました"
