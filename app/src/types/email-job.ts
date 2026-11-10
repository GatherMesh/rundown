import type { Timestamp } from 'firebase/firestore';

export interface EmailJob {
  id: string;
  personId: string;
  recipientName: string;
  email: string;
  subject: string;
  message: string;
  status: 'queued' | 'preparing' | 'sending' | 'sent' | 'failed';
  attempt: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  error: string;
  retryable?: boolean;
}
