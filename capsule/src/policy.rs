use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Policy configuration loaded from JSON
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsguardPolicy {
    pub max_auto_trade_usd: u64,
    pub strict_anomaly_detection: bool,
    pub device_ip_lock: bool,
    pub remote_trigger_protection: bool,
    pub active_llm_engine: String,
}

impl Default for AsguardPolicy {
    fn default() -> Self {
        AsguardPolicy {
            max_auto_trade_usd: 50000,
            strict_anomaly_detection: true,
            device_ip_lock: true,
            remote_trigger_protection: true,
            active_llm_engine: "ollama".to_string(),
        }
    }
}

/// Policy store for loading and managing policies
pub struct PolicyStore {
    pub policy: AsguardPolicy,
    pub policy_path: String,
}

impl PolicyStore {
    /// Load policy from file, create default if not exists
    pub fn load(path: &str) -> Result<Self, String> {
        if Path::new(path).exists() {
            let content = fs::read_to_string(path)
                .map_err(|e| format!("Failed to read policy file: {}", e))?;

            let policy: AsguardPolicy = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse policy JSON: {}", e))?;

            Ok(PolicyStore {
                policy,
                policy_path: path.to_string(),
            })
        } else {
            // Create directory if needed
            if let Some(parent) = Path::new(path).parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create policy directory: {}", e))?;
            }

            let default_policy = AsguardPolicy::default();
            let json = serde_json::to_string_pretty(&default_policy)
                .map_err(|e| format!("Failed to serialize default policy: {}", e))?;

            fs::write(path, json)
                .map_err(|e| format!("Failed to write policy file: {}", e))?;

            Ok(PolicyStore {
                policy: default_policy,
                policy_path: path.to_string(),
            })
        }
    }

    /// Save policy to file
    pub fn save(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.policy)
            .map_err(|e| format!("Failed to serialize policy: {}", e))?;

        fs::write(&self.policy_path, json)
            .map_err(|e| format!("Failed to write policy file: {}", e))?;

        Ok(())
    }

    /// Update a single policy field
    pub fn update_field(&mut self, field: &str, value: serde_json::Value) -> Result<(), String> {
        match field {
            "max_auto_trade_usd" => {
                self.policy.max_auto_trade_usd = value
                    .as_u64()
                    .ok_or("Invalid value for max_auto_trade_usd")?;
            }
            "strict_anomaly_detection" => {
                self.policy.strict_anomaly_detection = value
                    .as_bool()
                    .ok_or("Invalid value for strict_anomaly_detection")?;
            }
            "device_ip_lock" => {
                self.policy.device_ip_lock =
                    value.as_bool().ok_or("Invalid value for device_ip_lock")?;
            }
            "remote_trigger_protection" => {
                self.policy.remote_trigger_protection = value
                    .as_bool()
                    .ok_or("Invalid value for remote_trigger_protection")?;
            }
            "active_llm_engine" => {
                self.policy.active_llm_engine = value
                    .as_str()
                    .ok_or("Invalid value for active_llm_engine")?
                    .to_string();
            }
            _ => return Err(format!("Unknown policy field: {}", field)),
        }

        self.save()
    }

    /// Reset to defaults
    pub fn reset_to_defaults(&mut self) -> Result<(), String> {
        self.policy = AsguardPolicy::default();
        self.save()
    }
}
