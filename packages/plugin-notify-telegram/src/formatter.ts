// ---- Notification -> Telegram HTML message formatter ----
// Uses HTML parse mode throughout — simpler escaping than MarkdownV2.

import type { Notification, NotificationLevel } from '@ouija/types';

// ---- Data shapes for typed pipeline events ----

export interface DispatchStartedData {
  agentName: string;
  cardTitle: string;
  cardId: string;
}

export interface PrReadyData {
  prUrl: string;
  prTitle: string;
  repoName: string;
}

export interface AgentFailedData {
  agentName: string;
  errorMessage: string;
  pipelineId?: string;
}

export interface StallDetectedData {
  agentName: string;
  stalledMinutes: number;
  pipelineId?: string;
}

// ---- HTML escaping ----

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * Telegram HTML requires escaping: & < >
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- Level icons ----

const LEVEL_ICON: Record<NotificationLevel, string> = {
  info: '\u2139\uFE0F',    // information
  warning: '\u26A0\uFE0F', // warning
  error: '\u274C',          // red X
  success: '\u2705',        // green check
};

// ---- Generic notification formatter ----

/**
 * Format any Notification into Telegram HTML text.
 * Renders: icon + bold title + blank line + body.
 */
export function formatNotification(notification: Notification): string {
  const icon = LEVEL_ICON[notification.level];
  const title = escapeHtml(notification.title);
  const body = escapeHtml(notification.body);

  return [
    `${icon} <b>${title}</b>`,
    '',
    body,
  ].join('\n');
}

// ---- Typed pipeline event formatters ----

/**
 * Agent started working on a card.
 * "Agent rex-coder started working on Card: Fix login bug"
 */
export function formatDispatchStarted(data: DispatchStartedData): string {
  const agentName = escapeHtml(data.agentName);
  const cardTitle = escapeHtml(data.cardTitle);
  const cardId = escapeHtml(data.cardId);

  return [
    `\u2139\uFE0F <b>Agent dispatched</b>`,
    '',
    `<b>${agentName}</b> started working on Card: <code>${cardId}</code>`,
    `<i>${cardTitle}</i>`,
  ].join('\n');
}

/**
 * Agent opened a PR.
 * "PR ready for review: [link]" with [View PR] button.
 */
export function formatPrReady(data: PrReadyData): string {
  const prTitle = escapeHtml(data.prTitle);
  const repoName = escapeHtml(data.repoName);
  const prUrl = escapeHtml(data.prUrl);

  return [
    `\u2705 <b>PR ready for review</b>`,
    '',
    `<b>${repoName}</b>: <a href="${prUrl}">${prTitle}</a>`,
  ].join('\n');
}

/**
 * Agent failed with an error.
 * "Agent failed: error message" with [Retry] [View] buttons.
 */
export function formatAgentFailed(data: AgentFailedData): string {
  const agentName = escapeHtml(data.agentName);
  const errorMessage = escapeHtml(data.errorMessage);

  return [
    `\u274C <b>Agent failed</b>`,
    '',
    `<b>${agentName}</b> encountered an error:`,
    `<code>${errorMessage}</code>`,
  ].join('\n');
}

/**
 * Agent stalled — no heartbeat for N minutes.
 * "Agent stalled — no heartbeat for 5m" with [Retry] [Cancel] buttons.
 */
export function formatStallDetected(data: StallDetectedData): string {
  const agentName = escapeHtml(data.agentName);
  const minutes = data.stalledMinutes;

  return [
    `\u26A0\uFE0F <b>Agent stalled</b>`,
    '',
    `<b>${agentName}</b> — no heartbeat for <b>${minutes}m</b>`,
  ].join('\n');
}
