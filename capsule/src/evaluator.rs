use crate::policy::AsguardPolicy;
use crate::{EvaluationResult, RuleViolation};
use std::collections::HashMap;

/// Anomaly evaluator with 4 detection rules
pub struct Evaluator {
    profile_cache: HashMap<String, AgentProfile>,
}

/// Agent behavioral profile
#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub agent_id: String,
    pub baseline_frequency: f64,
    pub baseline_amount: f64,
    pub known_ips: Vec<String>,
    pub known_devices: Vec<String>,
    pub observation_count: usize,
}

impl Evaluator {
    pub fn new() -> Self {
        Evaluator {
            profile_cache: HashMap::new(),
        }
    }

    /// Evaluate a tool call against all 4 rules
    pub fn evaluate(
        &mut self,
        agent_id: &str,
        tool_name: &str,
        params: &serde_json::Value,
        policy: &AsguardPolicy,
    ) -> Result<EvaluationResult, String> {
        let mut score: u32 = 0;
        let mut rules_triggered: Vec<RuleViolation> = vec![];

        // Get or create profile
        let profile = self
            .profile_cache
            .entry(agent_id.to_string())
            .or_insert_with(|| AgentProfile {
                agent_id: agent_id.to_string(),
                baseline_frequency: 1.0,
                baseline_amount: 5000.0,
                known_ips: vec![],
                known_devices: vec![],
                observation_count: 0,
            });

        // Rule 1: Budget Overrun
        if let Some(amount) = params.get("amount_usd").and_then(|v| v.as_u64()) {
            if amount > policy.max_auto_trade_usd {
                score += 50;
                rules_triggered.push(RuleViolation {
                    rule_id: "budget_overrun".to_string(),
                    severity: "high".to_string(),
                    score_contribution: 50,
                    details: {
                        let mut m = HashMap::new();
                        m.insert("amount".to_string(), amount.to_string());
                        m.insert("max_allowed".to_string(), policy.max_auto_trade_usd.to_string());
                        m
                    },
                });
            }
        }

        // Rule 2: IP/Device Breach
        if policy.device_ip_lock {
            if let Some(ip) = params.get("ip_address").and_then(|v| v.as_str()) {
                if !profile.known_ips.contains(&ip.to_string()) && !profile.known_ips.is_empty() {
                    score += 40;
                    rules_triggered.push(RuleViolation {
                        rule_id: "ip_breach".to_string(),
                        severity: "high".to_string(),
                        score_contribution: 40,
                        details: {
                            let mut m = HashMap::new();
                            m.insert("ip".to_string(), ip.to_string());
                            m
                        },
                    });
                }
                profile.known_ips.push(ip.to_string());
            }

            if let Some(device) = params.get("device_id").and_then(|v| v.as_str()) {
                if !profile.known_devices.contains(&device.to_string())
                    && !profile.known_devices.is_empty()
                {
                    score += 35;
                    rules_triggered.push(RuleViolation {
                        rule_id: "device_breach".to_string(),
                        severity: "high".to_string(),
                        score_contribution: 35,
                        details: {
                            let mut m = HashMap::new();
                            m.insert("device".to_string(), device.to_string());
                            m
                        },
                    });
                }
                profile.known_devices.push(device.to_string());
            }
        }

        // Rule 3: Frequency Spike
        if profile.observation_count > 5 {
            if tool_name.contains("trade") || tool_name.contains("execute") {
                let current_frequency = 1.0;
                if current_frequency > profile.baseline_frequency * 3.0 {
                    score += 30;
                    rules_triggered.push(RuleViolation {
                        rule_id: "frequency_spike".to_string(),
                        severity: "medium".to_string(),
                        score_contribution: 30,
                        details: {
                            let mut m = HashMap::new();
                            m.insert(
                                "current".to_string(),
                                format!("{:.2}", current_frequency),
                            );
                            m.insert(
                                "baseline".to_string(),
                                format!("{:.2}", profile.baseline_frequency),
                            );
                            m
                        },
                    });
                }
            }
        }

        // Rule 4: Unverified Contract
        if let Some(contract) = params.get("contract_address").and_then(|v| v.as_str()) {
            if !is_whitelisted_contract(contract) {
                score += 45;
                rules_triggered.push(RuleViolation {
                    rule_id: "unverified_contract".to_string(),
                    severity: "high".to_string(),
                    score_contribution: 45,
                    details: {
                        let mut m = HashMap::new();
                        m.insert("contract".to_string(), contract.to_string());
                        m
                    },
                });
            }
        }

        profile.observation_count += 1;

        // Determine action based on score
        let (action, confidence) = match score {
            0..=39 => ("silent_pass".to_string(), 100.0),
            40..=69 => ("warn".to_string(), 85.0),
            _ => ("halt_and_hitl".to_string(), 95.0),
        };

        // Cap score at 100
        let capped_score = if score > 100 { 100 } else { score };

        Ok(EvaluationResult {
            agent_id: agent_id.to_string(),
            anomaly_score: capped_score,
            rules_triggered,
            action,
            confidence,
            timestamp: format!("{}Z", "2024-01-01T00:00:00"), // In production, use actual timestamp
        })
    }
}

/// Check if contract is whitelisted
fn is_whitelisted_contract(contract: &str) -> bool {
    matches!(
        contract.to_lowercase().as_str(),
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" | // USDC
        "0xdac17f958d2ee523a2206206994597c13d831ec7" | // USDT
        "0x2260fac5e5542a773aa44fbcff5aec1b93b0a5f0"    // WBTC
    )
}
