import crypto from 'node:crypto';
import type { ActivityMetadata, AgentActivityEvent } from './types';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function nestedString(source: JsonObject, path: string): string | undefined {
  let value: unknown = source;
  for (const segment of path.split('.')) value = object(value)[segment];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedObject(source: JsonObject, path: string): JsonObject {
  let value: unknown = source;
  for (const segment of path.split('.')) value = object(value)[segment];
  return object(value);
}

function booleanValue(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}

export interface PayPalWebhookMapping {
  event?: AgentActivityEvent;
  metadata?: ActivityMetadata;
  unmappedReason?: string;
}

/** Map PayPal's webhook envelope into the same normalized event contract used by REST and MCP. */
export function mapPayPalWebhook(payload: unknown): PayPalWebhookMapping {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Webhook body must be a JSON object.');
  const envelope = payload as JsonObject;
  const resource = object(envelope.resource);
  const purchaseUnit = object(Array.isArray(resource.purchase_units) ? resource.purchase_units[0] : undefined);
  const eventName = firstString(envelope.event_type)?.toUpperCase();
  if (!eventName) throw new Error('Webhook event_type is required.');

  let eventType: AgentActivityEvent['event_type'];
  let direction: 'incoming' | 'outgoing';
  let accountType: 'personal' | 'business';
  if (/PAYMENT\.CAPTURE|CHECKOUT\.ORDER|PAYMENT\.SALE|BILLING\.SUBSCRIPTION/.test(eventName)) {
    eventType = 'transaction';
    const isMerchantPayment = Boolean(firstString(
      nestedString(resource, 'payee.merchant_id'), resource.merchant_id, resource.seller_paypal_account_id,
      nestedString(purchaseUnit, 'payee.merchant_id'),
    ));
    accountType = isMerchantPayment ? 'business' : 'personal';
    direction = isMerchantPayment ? 'incoming' : 'outgoing';
  } else if (/LOGIN|AUTHENTICATION/.test(eventName)) {
    eventType = 'login'; accountType = 'personal'; direction = 'outgoing';
  } else if (/PASSWORD/.test(eventName)) {
    eventType = 'password_change'; accountType = 'personal'; direction = 'outgoing';
  } else if (/ACCOUNT|PROFILE|EMAIL|PHONE|IDENTITY/.test(eventName)) {
    eventType = 'account_update'; accountType = 'personal'; direction = 'outgoing';
  } else {
    // Unknown webhook families are acknowledged but not guessed into a payment/security event.
    return { unmappedReason: `PayPal event type '${eventName}' is not currently mapped.` };
  }

  const amountObject = object(resource.amount ?? resource.gross_amount ?? purchaseUnit.amount);
  const amountRaw = amountObject.value ?? resource.amount_usd;
  const amount = typeof amountRaw === 'number' ? amountRaw : typeof amountRaw === 'string' && amountRaw.trim() ? Number(amountRaw) : undefined;
  if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) throw new Error('Webhook amount must be a non-negative finite number.');
  const currency = firstString(amountObject.currency_code, amountObject.currency, resource.currency_code, resource.currency, purchaseUnit.amount && nestedString(purchaseUnit, 'amount.currency_code'));
  const payerId = firstString(nestedString(resource, 'payer.payer_id'), nestedString(resource, 'payer.account_id'), resource.payer_id, nestedString(resource, 'payer_info.payer_id'), envelope.payer_id);
  const merchantId = firstString(
    nestedString(resource, 'payee.merchant_id'), resource.merchant_id, resource.seller_paypal_account_id,
    nestedString(purchaseUnit, 'payee.merchant_id'),
  );
  const accountId = firstString(
    merchantId, resource.account_id, payerId, nestedString(resource, 'payer.payer_id'),
    envelope.merchant_id, envelope.account_id,
  ) ?? `paypal-webhook-${firstString(envelope.id) ?? crypto.randomUUID()}`;
  const relatedIds = nestedObject(resource, 'supplementary_data.related_ids');
  const transactionId = firstString(resource.id, resource.capture_id, resource.sale_id, relatedIds.capture_id, relatedIds.order_id, purchaseUnit.reference_id);
  const custom = object(resource.custom);
  const ipAddress = firstString(resource.ip_address, nestedString(resource, 'actor.ip_address'), nestedString(resource, 'device.ip_address'), envelope.ip_address);
  const deviceId = firstString(resource.device_id, nestedString(resource, 'device.id'), envelope.device_id);
  const location = firstString(resource.location, nestedString(resource, 'address.admin_area_2'), nestedString(resource, 'payer.address.country_code'), envelope.location);
  const fingerprint = firstString(resource.instrument_fingerprint, nestedString(resource, 'payment_source.card.fingerprint'), nestedString(resource, 'payment_source.token.fingerprint'), envelope.instrument_fingerprint);
  const cardBin = firstString(resource.card_bin, nestedString(resource, 'payment_source.card.bin'), nestedString(resource, 'payment_source.card.bin_number'), envelope.card_bin);
  const payerCountry = firstString(resource.payer_country, nestedString(resource, 'payer.address.country_code'), nestedString(resource, 'payer_info.country_code'), envelope.payer_country);

  const metadata: ActivityMetadata = {
    account_id: accountId, event_type: eventType, account_type: accountType, event_direction: direction,
    amount, amount_usd: currency?.toUpperCase() === 'USD' ? amount : undefined, currency, ip_address: ipAddress, device_id: deviceId, location,
    merchant_id: merchantId, transaction_id: transactionId, payer_id: payerId,
    payer_device_id: firstString(resource.payer_device_id, nestedString(resource, 'payer.device_id'), nestedString(resource, 'payer.device.id'), envelope.payer_device_id),
    instrument_fingerprint: fingerprint, card_bin: cardBin,
    high_risk_bin: booleanValue(resource.high_risk_bin, custom.high_risk_bin),
    known_bad_instrument: booleanValue(resource.known_bad_instrument, custom.known_bad_instrument),
    payer_country: payerCountry, instrument_country: firstString(resource.instrument_country, nestedString(resource, 'payment_source.card.country_code')),
  };
  const event: AgentActivityEvent = {
    type: 'agent_activity', timestamp: firstString(envelope.create_time) ?? new Date().toISOString(),
    id: `paypal_${firstString(envelope.id) ?? crypto.randomUUID()}`, agent_id: accountId, account_id: accountId,
    agent_name: merchantId ? `PayPal merchant ${merchantId}` : `PayPal account ${accountId}`,
    event_type: eventType, account_type: accountType, event_direction: direction,
    action: firstString(envelope.summary) ?? eventName, risk_level: 'low',
    details: {
      source: 'paypal_webhook', paypal_event_id: firstString(envelope.id) ?? null, paypal_event_type: eventName,
      payment: { amount: amount ?? null, currency: currency ?? null, merchant_id: merchantId ?? null, transaction_id: transactionId ?? null, payer_id: payerId ?? null },
      session: { ip_address: ipAddress ?? null, device_id: deviceId ?? null, location: location ?? null },
    },
  };
  return { event, metadata };
}
