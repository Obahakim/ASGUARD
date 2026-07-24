# ASGUARD and Unicity AOS

## Overview

ASGUARD is being shaped into an AOS-aligned capsule that can participate in an Astrid runtime environment as a guardian module for agent policy enforcement, event monitoring, HITL approval, and audit visibility.

## Current AOS-aligned improvements

- Explicit capability boundaries for policy management, event monitoring, HITL approval, and audit anchoring
- Capsule manifest metadata describing the runtime role of the module
- Provider registry abstraction for AOS-compatible provider selection
- Runtime bridge abstraction for future integration with Astrid/AOS host APIs

## Next directions

- Connect the runtime bridge to actual Astrid runtime event streams
- Replace simulated provider choices with real adapter-backed providers
- Add richer AOS packaging metadata for capsule registration and discoverability
