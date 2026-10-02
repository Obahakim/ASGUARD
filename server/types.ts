export interface AsguardPolicy {
	max_auto_trade_usd: number;
	strict_anomaly_detection: boolean;
	device_ip_lock: boolean;
	remote_trigger_protection: boolean;
	active_llm_engine: 'ollama' | 'claude' | 'groq';
	updated_at?: string;
	version?: string;
}

export type EventType =
	| 'agent_activity'
	| 'capability_check'
	| 'anomaly_detected'
	| 'security_violation'
	| 'hitl_request'
	| 'audit_log'
	| 'policy_update'
	| 'connection_status'
	| 'subscription_confirmed';

export interface BaseEvent {
	type: EventType;
	timestamp: string;
	id: string;
}

export interface AgentActivityEvent extends BaseEvent {
	type: 'agent_activity';
	agent_id: string;
	agent_name: string;
	action: string;
	risk_level: 'low' | 'medium' | 'high';
	details: Record<string, unknown>;
}

export interface CapabilityCheckEvent extends BaseEvent {
	type: 'capability_check';
	agent_id: string;
	capability: string;
	status: 'allowed' | 'denied';
	reason?: string;
}

export interface AnomalyDetectionEvent extends BaseEvent {
	type: 'anomaly_detected';
	agent_id: string;
	anomaly_type: string;
	confidence_score: number;
	details: Record<string, unknown>;
}

export interface SecurityViolationEvent extends BaseEvent {
	type: 'security_violation';
	agent_id: string;
	violation_type: string;
	severity: 'low' | 'medium' | 'high' | 'critical';
	requires_hitl: boolean;
	context: Record<string, unknown>;
}

export interface HITLRequestEvent extends BaseEvent {
	type: 'hitl_request';
	request_id: string;
	agent_id: string;
	incident_type: string;
	context: Record<string, unknown>;
	action_options: string[];
	expires_at: string;
}

export interface AuditLogEvent extends BaseEvent {
	type: 'audit_log';
	agent_id?: string;
	action: string;
	resource: string;
	status: 'success' | 'failure';
	details?: Record<string, unknown> | unknown;
}

export interface PolicyUpdateEvent extends BaseEvent {
	type: 'policy_update';
	field: string;
	old_value: unknown;
	new_value: unknown;
}

export interface ConnectionStatusEvent extends BaseEvent {
	type: 'connection_status';
	status: 'connected' | 'disconnected';
	daemon: string;
}

export type Event =
	| AgentActivityEvent
	| CapabilityCheckEvent
	| AnomalyDetectionEvent
	| SecurityViolationEvent
	| HITLRequestEvent
	| AuditLogEvent
	| PolicyUpdateEvent
	| ConnectionStatusEvent;

export interface WebSocketMessage {
	type: 'subscribe' | 'unsubscribe' | 'event' | 'policy_update' | 'hitl_response';
	payload: unknown;
}

export interface SubscriptionMessage {
	type: 'subscribe';
	payload: {
		event_types?: EventType[];
		agent_ids?: string[];
	};
}

export interface HITLResponse extends Record<string, unknown> {
	request_id: string;
	action: 'allow_once' | 'allow_session' | 'deny_terminate';
	reason?: string;
}

export interface PolicyUpdateRequest {
	field: keyof AsguardPolicy;
	value: unknown;
}

export interface PolicyResponse {
	success: boolean;
	policy?: AsguardPolicy;
	error?: string;
}

export interface HealthCheckResponse {
	status: 'ok' | 'degraded' | 'error';
	daemon_connected: boolean;
	timestamp: string;
	version: string;
	runtime: string;
	capabilities: string[];
}

export interface AnomalyProfile {
	agent_id: string;
	baseline_trade_frequency: number;
	baseline_avg_amount_usd: number;
	baseline_ips: Set<string>;
	baseline_devices: Set<string>;
	first_seen: Date;
	last_updated: Date;
	observation_count: number;
}

export interface EvaluationResult {
	agent_id: string;
	anomaly_score: number;
	rules_triggered: RuleViolation[];
	action: 'silent_pass' | 'warn' | 'halt_and_hitl';
	confidence: number;
	timestamp: string;
}

export interface RuleViolation {
	rule_id: 'ip_breach' | 'budget_overrun' | 'frequency_spike' | 'unverified_contract';
	severity: 'high' | 'medium';
	score_contribution: number;
	details: Record<string, unknown>;
}

export interface AuditChainEntry {
	sequence_number: number;
	timestamp: string;
	event_id: string;
	agent_id: string;
	action: string;
	anomaly_score?: number;
	previous_hash: string;
	entry_hash: string;
	signature: string;
}

export interface ContractValidationResult {
	contract_address: string;
	is_verified: boolean;
	verification_type: 'bytecode' | 'source' | 'abi';
	details: Record<string, unknown>;
	checked_at: string;
}

export type TransactionIntentStatus =
	| 'created'
	| 'evaluating'
	| 'blocked'
	| 'awaiting_approval'
	| 'approved'
	| 'rejected'
	| 'authorized'
	| 'submitted'
	| 'confirmed'
	| 'expired'
	| 'failed';

export interface TransactionSimulation {
	status: 'passed' | 'failed';
	simulated_at?: string;
	details?: Record<string, unknown>;
}

export interface TransactionIntent {
	id: string;
	idempotency_key: string;
	correlation_id: string;
	agent_id: string;
	wallet_id: string;
	network: string;
	action: string;
	resource: string;
	payload_hash: string;
	amount?: string | number;
	policy_version?: string;
	status: TransactionIntentStatus;
	risk_level: 'low' | 'medium' | 'high' | 'critical';
	expires_at: string;
	created_at: string;
	updated_at: string;
}

export interface AgentSphereOperator {
	wallet_address: string;
	role: 'operator';
	session_id: string;
	authenticated_at: string;
	expires_at: string;
}
