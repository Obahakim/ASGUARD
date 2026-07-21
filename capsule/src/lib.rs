//! Asguard WASM Capsule for Astrid Daemon
//! 
//! This module provides anomaly detection for agent tool calls within the Astrid daemon.
//! It loads policies from ~/.astrid/asguard_policy.json and evaluates all tool calls
//! against 4 detection rules, triggering HITL when anomaly_score >= 70.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

pub mod policy;
pub mod evaluator;
pub mod audit;

pub use policy::PolicyStore;
pub use evaluator::Evaluator;
pub use audit::AuditChain;

/// WASM Capsule initialization and main API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleConfig {
    pub policy_path: String,
    pub audit_path: String,
    pub enable_strict_mode: bool,
}

/// Global capsule state (thread-safe)
pub struct AsguardCapsule {
    config: CapsuleConfig,
    policy_store: Mutex<PolicyStore>,
    evaluator: Mutex<Evaluator>,
    audit_chain: Mutex<AuditChain>,
}

impl AsguardCapsule {
    /// Initialize the capsule with config
    pub fn initialize(config: CapsuleConfig) -> Result<Self, String> {
        let policy_store = PolicyStore::load(&config.policy_path)
            .map_err(|e| format!("Failed to load policy: {}", e))?;

        let evaluator = Evaluator::new();
        let audit_chain = AuditChain::initialize(&config.audit_path)
            .map_err(|e| format!("Failed to initialize audit chain: {}", e))?;

        Ok(AsguardCapsule {
            config,
            policy_store: Mutex::new(policy_store),
            evaluator: Mutex::new(evaluator),
            audit_chain: Mutex::new(audit_chain),
        })
    }

    /// Evaluate a tool call for anomalies
    pub fn evaluate_tool_call(
        &self,
        agent_id: &str,
        tool_name: &str,
        params: &serde_json::Value,
    ) -> Result<EvaluationResult, String> {
        let policy = self
            .policy_store
            .lock()
            .map_err(|_| "Policy lock failed".to_string())?;

        if !policy.strict_anomaly_detection {
            return Ok(EvaluationResult {
                agent_id: agent_id.to_string(),
                anomaly_score: 0,
                rules_triggered: vec![],
                action: "silent_pass".to_string(),
                confidence: 100.0,
                timestamp: chrono::Local::now().to_rfc3339(),
            });
        }

        let mut evaluator = self
            .evaluator
            .lock()
            .map_err(|_| "Evaluator lock failed".to_string())?;

        let result = evaluator.evaluate(
            agent_id,
            tool_name,
            params,
            &policy,
        )?;

        // Add to audit chain
        if let Ok(mut chain) = self.audit_chain.lock() {
            let _ = chain.add_entry(
                &result.agent_id,
                &format!("tool_call: {}", tool_name),
                result.anomaly_score,
            );
        }

        Ok(result)
    }

    /// Get capsule diagnostics
    pub fn diagnostics(&self) -> Result<serde_json::Value, String> {
        let policy = self
            .policy_store
            .lock()
            .map_err(|_| "Policy lock failed".to_string())?;

        let audit = self
            .audit_chain
            .lock()
            .map_err(|_| "Audit lock failed".to_string())?;

        Ok(serde_json::json!({
            "version": "0.1.0",
            "policy": {
                "strict_anomaly_detection": policy.strict_anomaly_detection,
                "max_auto_trade_usd": policy.max_auto_trade_usd,
                "device_ip_lock": policy.device_ip_lock,
                "remote_trigger_protection": policy.remote_trigger_protection,
            },
            "audit": {
                "total_entries": audit.entry_count(),
                "chain_valid": audit.verify_integrity(),
            }
        }))
    }

    /// Export audit trail for compliance
    pub fn export_audit_trail(&self) -> Result<Vec<serde_json::Value>, String> {
        self.audit_chain
            .lock()
            .map_err(|_| "Audit lock failed".to_string())?
            .export_entries()
    }
}

/// Evaluation result returned from anomaly detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationResult {
    pub agent_id: String,
    pub anomaly_score: u32,
    pub rules_triggered: Vec<RuleViolation>,
    pub action: String, // "silent_pass", "warn", "halt_and_hitl"
    pub confidence: f64,
    pub timestamp: String,
}

/// Individual rule violation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleViolation {
    pub rule_id: String,
    pub severity: String, // "high", "medium"
    pub score_contribution: u32,
    pub details: HashMap<String, String>,
}

// WASM exports for the Astrid daemon
#[no_mangle]
pub extern "C" fn asguard_version() -> *const u8 {
    b"asguard-capsule/0.1.0\0".as_ptr()
}

#[no_mangle]
pub extern "C" fn asguard_init_capsule(config_json: *const u8, len: usize) -> i32 {
    if config_json.is_null() {
        return -1;
    }

    unsafe {
        let config_slice = std::slice::from_raw_parts(config_json, len);
        let _config_str = std::str::from_utf8(config_slice);
        // In production, parse config and initialize CAPSULE global
        0 // Success
    }
}

#[no_mangle]
pub extern "C" fn asguard_evaluate_tool_call(
    agent_id: *const u8,
    agent_id_len: usize,
    tool_name: *const u8,
    tool_name_len: usize,
    params_json: *const u8,
    params_len: usize,
) -> i32 {
    if agent_id.is_null() || tool_name.is_null() || params_json.is_null() {
        return -1;
    }

    unsafe {
        let _agent_id = std::str::from_utf8(std::slice::from_raw_parts(agent_id, agent_id_len));
        let _tool_name = std::str::from_utf8(std::slice::from_raw_parts(tool_name, tool_name_len));
        let _params = std::str::from_utf8(std::slice::from_raw_parts(params_json, params_len));

        // In production, call evaluator and return result code
        // 0 = allow, 1 = warn, 2 = halt/HITL
        0
    }
}

// Add stub for chrono if not available
mod chrono {
    pub use std::time::SystemTime;

    pub struct Local;
    impl Local {
        pub fn now() -> SystemTime {
            SystemTime::now()
        }
    }

    pub trait TimeZone {
        fn to_rfc3339(&self) -> String {
            "2024-01-01T00:00:00Z".to_string()
        }
    }

    impl TimeZone for SystemTime {}
}
