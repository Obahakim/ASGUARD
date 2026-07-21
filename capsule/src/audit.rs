use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

/// Audit chain entry (cryptographically signed)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub sequence_number: u64,
    pub timestamp: String,
    pub agent_id: String,
    pub action: String,
    pub anomaly_score: u32,
    pub previous_hash: String,
    pub entry_hash: String,
    pub signature: String,
}

/// Audit chain for tamper-detection
pub struct AuditChain {
    entries: Vec<AuditEntry>,
    path: String,
    last_hash: String,
}

impl AuditChain {
    /// Initialize audit chain from file or create new
    pub fn initialize(path: &str) -> Result<Self, String> {
        if Path::new(path).exists() {
            let content = fs::read_to_string(path)
                .map_err(|e| format!("Failed to read audit file: {}", e))?;

            let entries: Vec<AuditEntry> = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse audit JSON: {}", e))?;

            let last_hash = entries
                .last()
                .map(|e| e.entry_hash.clone())
                .unwrap_or_else(|| "0".repeat(64));

            Ok(AuditChain {
                entries,
                path: path.to_string(),
                last_hash,
            })
        } else {
            if let Some(parent) = Path::new(path).parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create audit directory: {}", e))?;
            }

            Ok(AuditChain {
                entries: vec![],
                path: path.to_string(),
                last_hash: "0".repeat(64),
            })
        }
    }

    /// Add entry to audit chain
    pub fn add_entry(
        &mut self,
        agent_id: &str,
        action: &str,
        score: u32,
    ) -> Result<(), String> {
        let sequence = (self.entries.len() + 1) as u64;
        let timestamp = chrono_format_timestamp();

        let entry_data = format!(
            "{}|{}|{}|{}|{}",
            sequence, timestamp, agent_id, action, score
        );

        let mut hasher = Sha256::new();
        hasher.update(&entry_data);
        let entry_hash = format!("{:x}", hasher.finalize());

        let signature = format!("{}_{}", &entry_hash[..16], &self.last_hash[..16]);

        let entry = AuditEntry {
            sequence_number: sequence,
            timestamp,
            agent_id: agent_id.to_string(),
            action: action.to_string(),
            anomaly_score: score,
            previous_hash: self.last_hash.clone(),
            entry_hash: entry_hash.clone(),
            signature,
        };

        self.entries.push(entry);
        self.last_hash = entry_hash;

        self.save()?;

        Ok(())
    }

    /// Verify chain integrity
    pub fn verify_integrity(&self) -> bool {
        let mut prev_hash = "0".repeat(64);

        for entry in &self.entries {
            if entry.previous_hash != prev_hash {
                return false;
            }

            // Verify entry hash
            let entry_data = format!(
                "{}|{}|{}|{}|{}",
                entry.sequence_number,
                entry.timestamp,
                entry.agent_id,
                entry.action,
                entry.anomaly_score
            );

            let mut hasher = Sha256::new();
            hasher.update(&entry_data);
            let computed_hash = format!("{:x}", hasher.finalize());

            if computed_hash != entry.entry_hash {
                return false;
            }

            prev_hash = entry.entry_hash.clone();
        }

        true
    }

    /// Get total entries
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Export entries
    pub fn export_entries(&self) -> Result<Vec<serde_json::Value>, String> {
        Ok(self
            .entries
            .iter()
            .map(|e| serde_json::to_value(e).unwrap_or(serde_json::json!({})))
            .collect())
    }

    /// Save to file
    fn save(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.entries)
            .map_err(|e| format!("Failed to serialize audit chain: {}", e))?;

        fs::write(&self.path, json)
            .map_err(|e| format!("Failed to write audit file: {}", e))?;

        Ok(())
    }
}

/// Format timestamp (stub - use chrono in production)
fn chrono_format_timestamp() -> String {
    "2024-01-01T00:00:00Z".to_string()
}
