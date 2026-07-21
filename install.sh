#!/bin/bash

set -e

echo ""
echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║             Asguard - Local Astrid Daemon Integration              ║"
echo "║                    Phase 4: Installation Script                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check dependencies
echo -e "${BLUE}Checking dependencies...${NC}"

if ! command -v rustc &> /dev/null; then
    echo -e "${RED}✗ Rust/Cargo not found${NC}"
    echo "  Install from: https://rustup.rs/"
    exit 1
fi
echo -e "${GREEN}✓ Rust${NC}"

if ! command -v cargo &> /dev/null; then
    echo -e "${RED}✗ Cargo not found${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Cargo${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found${NC}"
    echo "  Install from: https://nodejs.org/"
    exit 1
fi
echo -e "${GREEN}✓ Node.js${NC}"

if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}⚠ pnpm not found, using npm instead${NC}"
    PKG_MANAGER="npm"
else
    PKG_MANAGER="pnpm"
    echo -e "${GREEN}✓ pnpm${NC}"
fi

# Optional: check for astrid-cli
if ! command -v astrid &> /dev/null; then
    echo -e "${YELLOW}⚠ astrid-cli not found (optional)${NC}"
    echo "  Install from: https://github.com/astridxyz/astrid-cli"
    ASTRID_AVAILABLE=false
else
    echo -e "${GREEN}✓ astrid-cli${NC}"
    ASTRID_AVAILABLE=true
fi

echo ""
echo -e "${BLUE}Setting up Asguard...${NC}"

# Create ~/.astrid directory
ASTRID_HOME="$HOME/.astrid"
mkdir -p "$ASTRID_HOME"
echo -e "${GREEN}✓ Created${NC} $ASTRID_HOME"

# Initialize policy file if not exists
POLICY_FILE="$ASTRID_HOME/asguard_policy.json"
if [ ! -f "$POLICY_FILE" ]; then
    cat > "$POLICY_FILE" << 'POLICY'
{
  "max_auto_trade_usd": 50000,
  "strict_anomaly_detection": true,
  "device_ip_lock": true,
  "remote_trigger_protection": true,
  "active_llm_engine": "ollama"
}
POLICY
    echo -e "${GREEN}✓ Created${NC} $POLICY_FILE"
else
    echo -e "${YELLOW}✓ Policy file already exists${NC} $POLICY_FILE"
fi

# Install Node dependencies
echo ""
echo -e "${BLUE}Installing Node.js dependencies...${NC}"
cd "$(dirname "$0")"
$PKG_MANAGER install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Build Rust capsule
echo ""
echo -e "${BLUE}Building Rust capsule...${NC}"

if [ -d "capsule" ]; then
    cd capsule
    
    # Set target to wasm if needed (in production with wasm32-unknown-unknown)
    # For now, compile as regular library
    cargo build --release 2>&1 | tail -5
    
    echo -e "${GREEN}✓ Capsule built${NC}"
    cd ..
else
    echo -e "${YELLOW}⚠ Capsule directory not found${NC}"
fi

# Install to daemon if astrid-cli available
if [ "$ASTRID_AVAILABLE" = true ]; then
    echo ""
    echo -e "${BLUE}Installing capsule to daemon...${NC}"
    
    if [ -f "capsule/target/release/libasguard_capsule.so" ]; then
        # This is an example - actual path depends on platform
        # astrid capsule install ./capsule/target/release/libasguard_capsule.so
        echo -e "${YELLOW}⚠ Manual daemon installation needed${NC}"
        echo "  Run: astrid capsule install ./capsule/target/release/libasguard_capsule.so"
    fi
fi

# Create CLI symlink/wrapper
echo ""
echo -e "${BLUE}Setting up CLI commands...${NC}"

if [ -f "scripts/asguard.sh" ]; then
    chmod +x scripts/asguard.sh
    
    # Try to create symlink in /usr/local/bin if possible
    if [ -w /usr/local/bin ]; then
        sudo ln -sf "$(pwd)/scripts/asguard.sh" /usr/local/bin/asguard
        echo -e "${GREEN}✓ Created${NC} /usr/local/bin/asguard"
    else
        echo -e "${YELLOW}⚠ Cannot write to /usr/local/bin${NC}"
        echo "  To install globally, run:"
        echo "  sudo ln -sf $(pwd)/scripts/asguard.sh /usr/local/bin/asguard"
    fi
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════════╗"
echo -e "${GREEN}✓ Asguard installation complete!${NC}"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start backend:  npm run dev  (or: pnpm dev)"
echo "  2. View dashboard: http://localhost:3000"
echo "  3. Check API:      curl http://localhost:8080/api/health"
echo ""
echo "Usage:"
echo "  $(pwd)/scripts/asguard.sh start     # Start backend + terminal UI"
echo "  $(pwd)/scripts/asguard.sh status    # Check service status"
echo "  $(pwd)/scripts/asguard.sh logs      # Stream live logs"
echo ""
