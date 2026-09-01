# ASGUARD - AI Agent Security Dashboard

A modern, dark-themed security operations panel for the Astrid/Unicity ecosystem. ASGUARD monitors local AI agents, detects anomalies, enforces security rules, and requires human approval for high-risk actions.

## Features

### 1. **Top Navigation Bar**
- **Logo & Status**: ASGUARD branding with shield icon
- **Connection Status Badge**: Shows "Local Astrid Daemon: Connected (127.0.0.1:8080)" with pulsing green indicator
- **LLM Engine Selector**: Dropdown to switch between "Ollama (Local - $0)", "Claude 3.7 API", or "Groq"

### 2. **Tab Navigation**
- **Overview**: Main dashboard with all three columns
- **Rule Settings**: Advanced security policy configuration
- **Audit Logs**: Full transaction and event history

### 3. **Main Dashboard Grid (3 Columns)**

#### Column 1: Observed Agents & Activity Feed
- Real-time list of monitored agents (Trader-Bot-01, DeFi-Yield-Agent, etc.)
- Live activity log showing:
  - Timestamp (HH:MM:SS format)
  - Agent name
  - Action type
  - Risk score (Low/Medium/High with color coding)
  - Status (Allowed/Audited)
- Interactive cards with hover effects
- "View All Logs" button for detailed history

#### Column 2: Security Rules & Threshold Controls
- **Max Auto-Trade Budget**: Interactive slider ($10K - $500K range)
- **Strict Anomaly Detection**: Toggle to enable/disable real-time pattern flagging
- **Device & IP Lock**: Toggle to restrict actions to registered devices
- **Remote Trigger Protection**: Toggle to require manual approval for remote calls
- Save/Reset buttons for rule configuration

#### Column 3: Anomaly Detection & Incident Log
- **High Priority Alerts** with color-coded severity:
  - Red for High severity
  - Yellow for Medium severity
  - Blue for Low severity
- **Expandable Incident Details** showing:
  - Trigger source
  - Device ID
  - IP address
  - Transaction amount
- **Quick Action Buttons**: Investigate, Freeze Agent, Dismiss

### 4. **Security Violation Modal (Human-in-the-Loop)**
High-priority approval gate that triggers on rule violations with:
- **Agent Information**: Name and identification
- **Violation Details**: Reason and context
- **Context Details**:
  - Trigger source (API endpoint)
  - Device ID
  - IP address
  - Transaction amount
- **Action Buttons**:
  - **Allow Once**: Single transaction approval
  - **Allow Session**: Approve for current session
  - **Deny & Terminate**: Block and terminate process

## Technology Stack

- **Frontend Framework**: Next.js 16 with React 19.2
- **Styling**: Tailwind CSS v4 with custom theme
- **Icons**: Lucide React
- **UI Components**: Custom shadcn/ui-inspired components
- **State Management**: React hooks (useState)
- **Typography**: Geist font family

## Design System

### Color Palette
- **Primary Background**: Dark slate (#0f172a)
- **Secondary**: Slate 900-950 (#1e293b, #0f172a)
- **Accent Green**: Emerald (#10b981) for "Connected" status
- **Warning Yellow**: Gold (#eab308) for medium-risk items
- **Alert Red**: Red (#ef4444) for high-risk/violation items
- **Info Cyan**: Cyan (#06b6d4) for primary interactive elements
- **Accent Purple**: Purple (#a855f7) for secondary elements

### Typography
- **Headings**: Geist Sans (bold, 18px-24px)
- **Body**: Geist Sans (regular, 14px-16px)
- **Monospace**: Geist Mono for IPs, device IDs, timestamps

### Interactive Elements
- **Buttons**: Hover state with background transitions
- **Toggles**: Smooth animated switches (green when on, gray when off)
- **Sliders**: Custom-styled range inputs with accent color
- **Cards**: Semi-transparent backgrounds with glassmorphism effect
- **Borders**: 1px solid rgba borders with low opacity

## Component Structure

```
app/
├── layout.tsx              # Root layout with metadata
├── page.tsx                # Main dashboard with tab routing
├── globals.css             # Global styles and theme
└── components/
    ├── Navbar.tsx          # Top navigation bar
    ├── Tabs.tsx            # Tab navigation component
    ├── ActivityFeed.tsx    # Agent activity log
    ├── SecurityRules.tsx   # Security controls
    ├── AnomalyDetection.tsx # Incident management
    └── ApprovalModal.tsx   # Human-in-the-loop approval
```

## Features Implemented

✅ Responsive 3-column grid layout  
✅ Tab-based navigation (Overview, Rules, Audit Logs)  
✅ Real-time activity feed with risk scoring  
✅ Interactive security rules with sliders and toggles  
✅ Expandable incident cards with action buttons  
✅ Modal overlay for approval gates  
✅ LLM engine selector dropdown  
✅ Connection status with pulsing indicator  
✅ Dark theme optimized for security dashboards  
✅ Accessible component structure with semantic HTML  
✅ Smooth animations and transitions  

## Security Features

- **Row-Level Security Pattern**: Ready for integration with backend auth
- **No Hardcoded Secrets**: All sensitive data can be parameterized
- **Input Validation**: Form fields ready for validation integration
- **State Isolation**: Component state is properly isolated
- **Secure by Default**: Dark theme reduces cognitive load for security operators

## Getting Started

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```

The app runs on `http://localhost:3000` and includes hot module reloading for rapid development.

### Build for Production
```bash
npm run build
npm start
```

## Pilot readiness

ASGUARD is currently a local security-control prototype. The end-to-end AgentSphere transaction pilot is being built fail-closed: missing Unicity credentials make live validation unavailable rather than fabricating success. Configure `UNICITY_NETWORK`, `UNICITY_WALLET_API_URL`, `UNICITY_ORACLE_API_KEY`, and optionally `UNICITY_DEVICE_ID` only through the runtime environment; never commit wallet or oracle material.

Current pilot status:
- Implemented: typed transaction intent and approval domain, runtime artifact protection, environment-based Unicity configuration.
- Requires configured services: live AgentSphere wallet authentication, validation, simulation, submission, and finality.
- Local fallback only: existing JSON policy/audit stores and demo dashboard fixtures.
- Not production-ready: mainnet operation, multisig governance, externally anchored audit evidence, complete daemon integration, and independent security review.

## Next Steps

1. Implement AgentSphere wallet challenge/signature verification for REST and WebSocket operators.
2. Persist transaction intents, approvals, incidents, and audit records in Neon.
3. Connect the transaction-intent state machine to Astrid execution and fail closed on unavailable validation.
4. Add live Unicity validation, simulation, submission, and finality tracking.
5. Replace demo dashboard data with authenticated API and WebSocket state.
6. Add adversarial tests, CI secret scanning, monitoring, multisig administration, and an independent security review before mainnet.

## Template Audit Results

This repository is a pilot scaffold, not a security certification. Do not treat its current local stores, dashboard fixtures, or adapter status as evidence of mainnet readiness.

---

**Built with v0 by Vercel** | AI Agent Security Dashboard for Astrid/Unicity Ecosystem
