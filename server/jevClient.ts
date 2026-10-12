import { choice, noul, score, TypeSafeClient, type JsonValue } from '@typesafe-ai/sdk';
import { ActivityMetadata, AgentActivityEvent, EvaluationResult, JevJudgment } from './types';

const client = process.env.TYPESAFE_API_KEY
  ? new TypeSafeClient({ timeout: 8_000, retry: { maxRetries: 0 }, logLevel: 'off' })
  : undefined;
let jevDisplayStatus = client ? 'enabled' : 'JEV unavailable';

export function getJevStatus() {
  return { status: jevDisplayStatus };
}

/** Typed, structured Jev assessment. Missing credentials and provider errors never stop event ingestion. */
export async function assessWithJev(activity: AgentActivityEvent, metadata: ActivityMetadata, baseline: Record<string, unknown>, rules: EvaluationResult): Promise<JevJudgment> {
  if (!client) {
    jevDisplayStatus = 'JEV unavailable';
    return { status: 'disabled', error: 'TYPESAFE_API_KEY is not configured.' };
  }
  try {
    const state = {
      account_type: metadata.account_type ?? activity.account_type ?? 'personal',
      event_direction: metadata.event_direction ?? activity.event_direction ?? 'outgoing',
      event_type: metadata.event_type ?? activity.event_type ?? 'other',
      action: activity.action,
      amount: metadata.amount_usd ?? metadata.amount ?? null,
      currency: metadata.currency ?? 'USD',
      location: metadata.location ?? null,
      ip_known: metadata.ip_address !== undefined && Array.isArray(baseline.known_ips) ? baseline.known_ips.includes(metadata.ip_address) : null,
      device_known: metadata.device_id !== undefined && Array.isArray(baseline.known_devices) ? baseline.known_devices.includes(metadata.device_id) : null,
      payer_device_known: metadata.payer_device_id !== undefined && Array.isArray(baseline.known_payer_devices) ? baseline.known_payer_devices.includes(metadata.payer_device_id) : null,
      known_payer_device_count: Array.isArray(baseline.known_payer_devices) ? baseline.known_payer_devices.length : 0,
      merchant_id: metadata.merchant_id ?? null,
      card_bin: metadata.card_bin?.replace(/\s|-/g, '') ?? null,
      instrument_reported_high_risk: metadata.high_risk_bin === true,
      instrument_reported_bad: metadata.known_bad_instrument === true,
      account_baseline: JSON.parse(JSON.stringify({
        observations: baseline.observations ?? 0,
        average_amount_by_currency: baseline.avg_amount_by_currency ?? {},
      })) as JsonValue,
      deterministic_score: rules.anomaly_score,
      deterministic_findings: rules.rules_triggered.map((rule) => rule.rule_id),
    };

    // Business receipts need chargeback and payer-instrument judgments; consumer events use account protection questions.
    const merchantReceipt = state.account_type === 'business' && state.event_direction === 'incoming' && state.event_type === 'transaction';
    if (merchantReceipt) {
      const response = await client.systemOne({ state, questions: {
        suspicious_location: noul('Does the payer or instrument location look suspicious for this incoming business payment?'),
        anomalous_amount: noul('Is this incoming payment amount anomalous for the merchant and transaction context?'),
        chargeback_probability: noul('Is this payment likely to result in a chargeback?', {
          true: 'The payer, instrument, amount, velocity, or geographic evidence indicates elevated dispute or chargeback risk.',
          false: 'The available signals suggest a low likelihood of chargeback.',
        }),
        instrument_high_risk: noul('Is the payer instrument currently high-risk based on the available BIN and instrument history?', {
          true: 'The BIN, provider risk signals, or deterministic findings indicate a high-risk or known-bad instrument.',
          false: 'The available instrument signals do not indicate elevated risk.',
        }),
        fraud_probability: score('Score the probability this incoming merchant payment is fraudulent or likely to be disputed from 0 (low risk) to 4 (very high risk).', [
          'Low risk; available signals are consistent with legitimate payment.', 'Limited risk indicators.', 'Meaningful concern; merchant review is appropriate.',
          'High concern; challenge the payer before fulfillment.', 'Severe risk; decline the payment.',
        ]),
        merchant_action: choice('Choose the recommended action for the merchant receiving this payment.', {
          accept: 'Accept the payment and continue fulfillment.',
          accept_with_review: 'Accept while flagging for merchant review before fulfillment.',
          challenge: 'Challenge the payer or require additional verification.',
          decline: 'Decline the payment because chargeback or instrument risk is too high.',
        }),
      } });
      const action = response.answers.merchant_action.choice;
      const actionMap = { accept: 'allow', accept_with_review: 'notify', challenge: 'challenge', decline: 'hold' } as const;
      jevDisplayStatus = 'enabled';
      return {
        status: 'assessed', model: response.model,
        fraud_probability: Math.min(1, Math.max(0, response.answers.fraud_probability.score / 4)),
        confidence: Math.min(1, Math.max(0, response.answers.fraud_probability.confidence)),
        suspicious_location: response.answers.suspicious_location.noul,
        anomalous_amount: response.answers.anomalous_amount.noul,
        chargeback_probability: response.answers.chargeback_probability.noul,
        instrument_high_risk_probability: response.answers.instrument_high_risk.noul,
        recommended_action: actionMap[action],
        merchant_recommendation: action === 'accept_with_review' ? 'accept-with-review' : action,
        decision: `Jev recommends merchant action: ${action}; chargeback probability ${response.answers.chargeback_probability.noul.toFixed(2)}.`,
      };
    }

    const response = await client.systemOne({ state, questions: {
        suspicious_location: noul('Is this event from a suspicious or account-inconsistent location?', {
          true: 'The location or network context is unusual or inconsistent with the account baseline.',
          false: 'The location is consistent with the account baseline or no location signal is present.',
        }),
        anomalous_amount: noul('Is the payment amount anomalous for this account and event?', {
          true: 'The amount is unusually large or inconsistent with the account behavior.',
          false: 'The amount is plausible for the account or the event has no payment amount.',
        }),
        fraud_probability: score('Score the probability this account event is fraudulent from 0 (clearly legitimate) to 4 (strongly fraudulent). Consider account takeover, unusual amount, velocity, and recent sensitive changes.', [
          'No meaningful fraud indicators.', 'Weak or ambiguous indicators.', 'Some concerning indicators that merit monitoring.',
          'Strong indicators that warrant account verification.', 'Very strong indicators; hold the payment or account action for review.',
        ]),
        recommended_action: choice('Choose the least disruptive safe action supported by the evidence.', {
          allow: 'Allow and record the event.', notify: 'Allow while notifying the account owner or operator.',
          challenge: 'Require step-up authentication or human confirmation.', hold: 'Temporarily hold the payment/action for review.',
        }),
      },
    });
    const fraud = response.answers.fraud_probability;
    const decision = response.answers.recommended_action;
    jevDisplayStatus = 'enabled';
    return {
      status: 'assessed', model: response.model,
      fraud_probability: Math.min(1, Math.max(0, fraud.score / 4)),
      confidence: Math.min(1, Math.max(0, fraud.confidence)),
      suspicious_location: response.answers.suspicious_location.noul,
      anomalous_amount: response.answers.anomalous_amount.noul,
      recommended_action: decision.choice,
      decision: `Jev selected ${decision.choice}; probability ${decision.probabilities[decision.choice].toFixed(2)}.`,
    };
  } catch (error) {
    jevDisplayStatus = 'JEV unavailable';
    return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
  }
}
