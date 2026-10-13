import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationPreferences, users, wallets } from '../db/schema/index.js';
import { formatInr } from '../lib/money.js';

/** Which preference switch (if any) controls the email for an event. 'always' = cannot be turned off. */
export type EmailCategory = 'money_received' | 'money_sent' | 'payment_requests' | 'always';

export interface Effect {
  userId: string;
  notification: { type: string; title: string; message: string; data: Record<string, unknown> };
  email: { category: EmailCategory; subject: string; lines: string[] };
}

export interface OutboxEvent {
  id: bigint;
  eventType: string;
  payload: unknown;
}

type P = Record<string, string>;

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const rows = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Turns a committed domain event into the notifications and emails it should cause.
 * Unknown event types return no effects (they are marked processed, not retried forever).
 */
export async function effectsFor(event: OutboxEvent): Promise<Effect[]> {
  const p = event.payload as P;
  const amount = p.amount ? formatInr(BigInt(p.amount)) : '';
  const base = { transactionId: p.transactionId, publicId: p.publicId, amount: p.amount };

  switch (event.eventType) {
    case 'MONEY_ADDED':
      return [{
        userId: p.userId!,
        notification: { type: 'MONEY_RECEIVED', title: 'Money added', message: `${amount} was added to your wallet.`, data: base },
        email: { category: 'money_received', subject: `${amount} added to your MobilePay wallet`, lines: [`${amount} was added to your wallet.`, `Transaction ${p.publicId}.`] },
      }];
    case 'MONEY_SENT': {
      const name = (await userNames([p.counterpartyId!])).get(p.counterpartyId!) ?? 'a MobilePay user';
      return [{
        userId: p.userId!,
        notification: { type: 'MONEY_SENT', title: 'Payment sent', message: `You sent ${amount} to ${name}.`, data: base },
        email: { category: 'money_sent', subject: `You sent ${amount} to ${name}`, lines: [`You sent ${amount} to ${name}.`, `Transaction ${p.publicId}.`] },
      }];
    }
    case 'MONEY_RECEIVED': {
      // A paid request already produces its own "X paid your request" notification for the requester.
      if (p.viaRequest) return [];
      const name = (await userNames([p.counterpartyId!])).get(p.counterpartyId!) ?? 'a MobilePay user';
      return [{
        userId: p.userId!,
        notification: { type: 'MONEY_RECEIVED', title: 'Money received', message: `${amount} received from ${name}.`, data: base },
        email: { category: 'money_received', subject: `You received ${amount} from ${name}`, lines: [`${name} sent you ${amount}.`, `Transaction ${p.publicId}.`] },
      }];
    }
    case 'REVERSAL_DEBITED':
    case 'REVERSAL_CREDITED': {
      const [w] = await db.select({ userId: wallets.userId }).from(wallets).where(inArray(wallets.id, [p.walletId!]));
      if (!w?.userId) return [];
      const debited = event.eventType === 'REVERSAL_DEBITED';
      const message = debited
        ? `${amount} was taken back from your wallet because transfer ${p.originalPublicId} was reversed.`
        : `${amount} was returned to your wallet because transfer ${p.originalPublicId} was reversed.`;
      return [{
        userId: w.userId,
        notification: { type: 'SYSTEM', title: 'Transfer reversed', message, data: { ...base, originalPublicId: p.originalPublicId } },
        email: { category: 'always', subject: 'A transfer on your account was reversed', lines: [message, `Reference ${p.publicId}.`] },
      }];
    }
    case 'REQUEST_CREATED': {
      const name = (await userNames([p.requesterId!])).get(p.requesterId!) ?? 'Someone';
      const note = p.note ? ` for "${p.note}"` : '';
      return [{
        userId: p.payerId!,
        notification: { type: 'REQUEST_RECEIVED', title: 'Payment request', message: `${name} requested ${amount}${note}.`, data: { requestId: p.requestId, amount: p.amount } },
        email: { category: 'payment_requests', subject: `${name} requested ${amount}`, lines: [`${name} requested ${amount}${note}.`, 'Open MobilePay to pay or decline.'] },
      }];
    }
    case 'REQUEST_PAID': {
      const name = (await userNames([p.payerId!])).get(p.payerId!) ?? 'Someone';
      return [{
        userId: p.requesterId!,
        notification: { type: 'REQUEST_PAID', title: 'Request paid', message: `${name} paid your request of ${amount}.`, data: { requestId: p.requestId, publicId: p.publicId, amount: p.amount } },
        email: { category: 'payment_requests', subject: `${name} paid your ${amount} request`, lines: [`${name} paid your request of ${amount}.`, `Transaction ${p.publicId}.`] },
      }];
    }
    case 'REQUEST_REJECTED': {
      const name = (await userNames([p.payerId!])).get(p.payerId!) ?? 'Someone';
      return [{
        userId: p.requesterId!,
        notification: { type: 'REQUEST_REJECTED', title: 'Request declined', message: `${name} declined your request of ${amount}.`, data: { requestId: p.requestId, amount: p.amount } },
        email: { category: 'payment_requests', subject: `${name} declined your ${amount} request`, lines: [`${name} declined your request of ${amount}.`] },
      }];
    }
    case 'REQUEST_CANCELLED': {
      const name = (await userNames([p.requesterId!])).get(p.requesterId!) ?? 'Someone';
      return [{
        userId: p.payerId!,
        notification: { type: 'SYSTEM', title: 'Request cancelled', message: `${name} cancelled their request for ${amount}.`, data: { requestId: p.requestId, amount: p.amount } },
        email: { category: 'payment_requests', subject: `${name} cancelled a ${amount} request`, lines: [`${name} cancelled their request for ${amount}. Nothing is due.`] },
      }];
    }
    case 'REQUEST_EXPIRED': {
      const name = (await userNames([p.payerId!])).get(p.payerId!) ?? 'the recipient';
      return [{
        userId: p.requesterId!,
        notification: { type: 'REQUEST_EXPIRED', title: 'Request expired', message: `Your request of ${amount} to ${name} expired unpaid.`, data: { requestId: p.requestId, amount: p.amount } },
        email: { category: 'payment_requests', subject: `Your ${amount} request expired`, lines: [`Your request of ${amount} to ${name} expired without payment.`] },
      }];
    }
    case 'ACCOUNT_FROZEN':
      return [{
        userId: p.userId!,
        notification: { type: 'ACCOUNT_STATUS', title: 'Your wallet was frozen', message: `Payments from your wallet are paused. You can still log in and view your history. Reason: ${p.reason}. Please contact support.`, data: {} },
        email: { category: 'always', subject: 'Your MobilePay wallet was frozen', lines: [`Payments from your wallet are paused. Reason: ${p.reason}.`, 'You can still log in and view your balance and history. Please contact support.'] },
      }];
    case 'ACCOUNT_UNFROZEN':
      return [{
        userId: p.userId!,
        notification: { type: 'ACCOUNT_STATUS', title: 'Your wallet is active again', message: 'Your wallet was unfrozen. You can send and receive money again.', data: {} },
        email: { category: 'always', subject: 'Your MobilePay wallet is active again', lines: ['Your wallet was unfrozen. You can send and receive money again.'] },
      }];
    case 'WITHDRAWAL_REQUESTED':
      return [{
        userId: p.userId!,
        notification: { type: 'WITHDRAWAL_UPDATE', title: 'Withdrawal started', message: `${amount} is on its way to ${p.destination}.`, data: base },
        email: { category: 'money_sent', subject: `Withdrawal of ${amount} started`, lines: [`${amount} is on its way to ${p.destination}.`, `Transaction ${p.publicId}.`] },
      }];
    case 'WITHDRAWAL_COMPLETED':
      return [{
        userId: p.userId!,
        notification: { type: 'WITHDRAWAL_UPDATE', title: 'Withdrawal completed', message: `${amount} reached ${p.destination}.`, data: base },
        email: { category: 'money_sent', subject: `${amount} withdrawn to ${p.destination}`, lines: [`${amount} reached ${p.destination}.`, `Transaction ${p.publicId}.`] },
      }];
    case 'WITHDRAWAL_FAILED':
      return [{
        userId: p.userId!,
        notification: { type: 'WITHDRAWAL_UPDATE', title: 'Withdrawal failed, money returned', message: `Your ${amount} withdrawal to ${p.destination} failed. The full amount is back in your wallet.`, data: base },
        email: { category: 'always', subject: `Withdrawal failed: ${amount} returned to your wallet`, lines: [`Your ${amount} withdrawal to ${p.destination} could not be completed (${p.reason}).`, 'The full amount has been returned to your wallet.'] },
      }];
    default:
      return [];
  }
}

export async function emailAllowed(userId: string, category: EmailCategory): Promise<{ allowed: boolean; to?: string }> {
  const [u] = await db.select({ email: users.email }).from(users).where(inArray(users.id, [userId]));
  if (!u) return { allowed: false };
  if (category === 'always') return { allowed: true, to: u.email };
  const [prefs] = await db.select().from(notificationPreferences).where(inArray(notificationPreferences.userId, [userId]));
  // No row means defaults, and the defaults are on.
  const on =
    category === 'money_received' ? (prefs?.emailMoneyReceived ?? true) : category === 'payment_requests' ? (prefs?.emailPaymentRequests ?? true) : (prefs?.emailMoneySent ?? true);
  return { allowed: on, to: u.email };
}
