#!/bin/bash

# Asguard CLI Wrapper
# Provides convenient commands for daemon integration

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=8080
FRONTEND_PORT=3000
POLICY_FILE="$HOME/.astrid/asguard_policy.json"
AUDIT_FILE="$HOME/.astrid/audit_chain.json"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Command: start
cmd_start() {
    log_info "Starting Asguard backend and frontend..."
    cd "$PROJECT_DIR"
    
    log_info "Starting backend on http://localhost:$BACKEND_PORT"
    log_info "Starting frontend on http://localhost:$FRONTEND_PORT"
    log_info "Press Ctrl+C to stop"
    echo ""
    
    npm run dev || pnpm dev
}

# Command: status
cmd_status() {
    echo ""
    echo "Asguard System Status:"
    echo "────────────────────────────────────────"
    
    # Check backend
    if curl -s http://localhost:$BACKEND_PORT/api/health > /dev/null 2>&1; then
        log_success "Backend is running (http://localhost:$BACKEND_PORT)"
        
        # Get health details
        HEALTH=$(curl -s http://localhost:$BACKEND_PORT/api/health)
        echo "  Status: $(echo $HEALTH | grep -o '"status":"[^"]*"' | cut -d'"' -f4)"
    else
        log_warn "Backend is not running"
    fi
    
    # Check frontend
    if curl -s http://localhost:$FRONTEND_PORT > /dev/null 2>&1; then
        log_success "Frontend is running (http://localhost:$FRONTEND_PORT)"
    else
        log_warn "Frontend is not running"
    fi
    
    # Check policy file
    if [ -f "$POLICY_FILE" ]; then
        log_success "Policy file exists: $POLICY_FILE"
    else
        log_warn "Policy file not found: $POLICY_FILE"
    fi
    
    # Check audit chain
    if [ -f "$AUDIT_FILE" ]; then
        ENTRIES=$(grep -o '"sequence_number"' "$AUDIT_FILE" | wc -l)
        log_success "Audit chain: $ENTRIES entries"
    else
        log_warn "Audit chain not initialized"
    fi
    
    echo ""
}

# Command: logs
cmd_logs() {
    log_info "Streaming live logs (Ctrl+C to stop)..."
    echo ""
    
    # In production, this would tail actual log files
    # For now, stream from API diagnostics
    while true; do
        clear
        echo "Asguard Live Diagnostics"
        echo "════════════════════════════════════════"
        curl -s http://localhost:$BACKEND_PORT/api/anomaly/diagnostics | jq '.' 2>/dev/null || echo "Backend not available"
        sleep 5
    done
}

# Command: policy
cmd_policy() {
    local action="$1"
    
    case "$action" in
        get)
            if [ -f "$POLICY_FILE" ]; then
                log_info "Current policy:"
                jq '.' "$POLICY_FILE"
            else
                log_error "Policy file not found"
                exit 1
            fi
            ;;
        set)
            local field="$2"
            local value="$3"
            
            if [ -z "$field" ] || [ -z "$value" ]; then
                log_error "Usage: asguard policy set <field> <value>"
                echo "  Fields: max_auto_trade_usd, strict_anomaly_detection,"
                echo "          device_ip_lock, remote_trigger_protection,"
                echo "          active_llm_engine"
                exit 1
            fi
            
            curl -s -X POST "http://localhost:$BACKEND_PORT/api/policy" \
                -H "Content-Type: application/json" \
                -d "{\"field\":\"$field\",\"value\":$value}" | jq '.'
            ;;
        reset)
            log_warn "Resetting policy to defaults..."
            curl -s -X POST "http://localhost:$BACKEND_PORT/api/policy/reset" | jq '.'
            log_success "Policy reset"
            ;;
        *)
            echo "Policy commands:"
            echo "  asguard policy get              # Show current policy"
            echo "  asguard policy set <field> <value>"
            echo "  asguard policy reset            # Reset to defaults"
            ;;
    esac
}

# Command: audit
cmd_audit() {
    local action="$1"
    
    case "$action" in
        export)
            log_info "Exporting audit trail..."
            OUTPUT="${2:-asguard_audit_$(date +%Y%m%d_%H%M%S).json}"
            
            curl -s http://localhost:$BACKEND_PORT/api/anomaly/audit-trail | jq '.' > "$OUTPUT"
            log_success "Exported to $OUTPUT"
            echo "  $(wc -l < "$OUTPUT") lines"
            ;;
        verify)
            log_info "Verifying audit chain integrity..."
            RESULT=$(curl -s http://localhost:$BACKEND_PORT/api/anomaly/diagnostics | jq '.audit_chain_valid')
            
            if [ "$RESULT" = "true" ]; then
                log_success "Audit chain is valid and tamper-proof"
            else
                log_error "Audit chain integrity check failed"
                exit 1
            fi
            ;;
        *)
            echo "Audit commands:"
            echo "  asguard audit export [filename] # Export audit trail"
            echo "  asguard audit verify            # Verify chain integrity"
            ;;
    esac
}

# Command: uninstall
cmd_uninstall() {
    log_warn "This will remove Asguard from your system"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Remove CLI symlink
        if [ -L /usr/local/bin/asguard ]; then
            sudo rm /usr/local/bin/asguard
            log_success "Removed CLI command"
        fi
        
        # Keep policy and audit files in ~/.astrid
        log_info "Keeping policy and audit files in $HOME/.astrid"
        log_success "Uninstallation complete"
    else
        log_info "Uninstallation cancelled"
    fi
}

# Main command router
case "${1:-help}" in
    start)
        cmd_start
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs
        ;;
    policy)
        cmd_policy "${2:-get}" "$3" "$4"
        ;;
    audit)
        cmd_audit "${2:-help}" "$3"
        ;;
    uninstall)
        cmd_uninstall
        ;;
    help|--help|-h)
        cat << 'HELP'
Asguard CLI - Local Astrid Daemon Integration

USAGE:
  asguard <command> [options]

COMMANDS:
  start                      Start backend + frontend servers
  status                     Check system status
  logs                       Stream live diagnostics
  policy [get|set|reset]     Manage security policy
  audit [export|verify]      Manage audit trail
  uninstall                  Remove Asguard
  help                       Show this help

EXAMPLES:
  asguard start
  asguard status
  asguard policy get
  asguard policy set max_auto_trade_usd 100000
  asguard audit export compliance_report.json
  asguard audit verify

DOCUMENTATION:
  See PHASE4_DAEMON_INTEGRATION.md for full details
HELP
        ;;
    *)
        log_error "Unknown command: $1"
        echo ""
        $0 help
        exit 1
        ;;
esac
