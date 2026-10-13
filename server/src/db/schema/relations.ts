import { relations } from 'drizzle-orm';
import { auditLogs } from './auditLogs.js';
import { bankAccounts } from './bankAccounts.js';
import { beneficiaries } from './beneficiaries.js';
import { ledgerEntries } from './ledgerEntries.js';
import { notificationPreferences } from './notificationPreferences.js';
import { notifications } from './notifications.js';
import { paymentOrders } from './paymentOrders.js';
import { paymentRequests } from './paymentRequests.js';
import { refreshTokens } from './refreshTokens.js';
import { transactions } from './transactions.js';
import { users } from './users.js';
import { wallets } from './wallets.js';

export const usersRelations = relations(users, ({ one, many }) => ({
  wallet: one(wallets, { fields: [users.id], references: [wallets.userId] }),
  preferences: one(notificationPreferences, {
    fields: [users.id],
    references: [notificationPreferences.userId],
  }),
  refreshTokens: many(refreshTokens),
  notifications: many(notifications),
  bankAccounts: many(bankAccounts),
  auditLogs: many(auditLogs),
  beneficiaries: many(beneficiaries, { relationName: 'owner' }),
}));

export const walletsRelations = relations(wallets, ({ one, many }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
  ledgerEntries: many(ledgerEntries),
}));

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  senderWallet: one(wallets, {
    fields: [transactions.senderWalletId],
    references: [wallets.id],
    relationName: 'sender',
  }),
  receiverWallet: one(wallets, {
    fields: [transactions.receiverWalletId],
    references: [wallets.id],
    relationName: 'receiver',
  }),
  ledgerEntries: many(ledgerEntries),
  paymentRequest: one(paymentRequests, {
    fields: [transactions.paymentRequestId],
    references: [paymentRequests.id],
  }),
  paymentOrder: one(paymentOrders, {
    fields: [transactions.paymentOrderId],
    references: [paymentOrders.id],
  }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  transaction: one(transactions, {
    fields: [ledgerEntries.transactionId],
    references: [transactions.id],
  }),
  wallet: one(wallets, { fields: [ledgerEntries.walletId], references: [wallets.id] }),
}));

export const beneficiariesRelations = relations(beneficiaries, ({ one }) => ({
  owner: one(users, {
    fields: [beneficiaries.ownerId],
    references: [users.id],
    relationName: 'owner',
  }),
  beneficiary: one(users, {
    fields: [beneficiaries.beneficiaryUserId],
    references: [users.id],
    relationName: 'beneficiary',
  }),
}));

export const paymentRequestsRelations = relations(paymentRequests, ({ one }) => ({
  requester: one(users, {
    fields: [paymentRequests.requesterId],
    references: [users.id],
    relationName: 'requester',
  }),
  payer: one(users, {
    fields: [paymentRequests.payerId],
    references: [users.id],
    relationName: 'payer',
  }),
}));
