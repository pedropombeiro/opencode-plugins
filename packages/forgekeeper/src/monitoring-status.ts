import type { SubscriptionStatus } from './feedback-subscriptions';
import type { FetchHealth } from './request-cache';

export interface MonitoringStatus {
  enabled: boolean;
  directory: string;
  sessionID: string;
  discovered: boolean;
  leased: boolean;
  polling: boolean;
  paused: boolean;
  humanFeedback: boolean;
  automatedFeedback: boolean;
  status: FetchHealth;
  targets: {
    url: string;
    state?: string;
    feedbackWatched: boolean;
    status: FetchHealth;
    feedback: FetchHealth;
    subscription: SubscriptionStatus;
  }[];
}
