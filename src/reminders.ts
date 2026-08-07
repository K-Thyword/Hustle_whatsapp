// Customer-set reminders — "remind me to book for my hair appointment next
// week". A customer can ask the bot to remember something and get nudged
// about it later, at a specific date, without that turning into a booking
// right away. Backed by store.ts (Redis, with an automatic in-memory
// fallback), same as every other piece of this service's own state.
//
// Deletion test: without this, "remind me" requests would have nowhere to
// live between being asked and being due — the sweep in server.ts that
// fires them depends entirely on this module's list surviving a restart.

import { kvGet, kvSet, kvDelete, kvGetAllWithPrefix } from "./store";

export interface Reminder {
  id: string;
  phone: string;
  text: string; // what to remind them about, in their own words
  dueAt: number; // epoch ms
  fired: boolean;
  createdAt: number;
}

const REMINDER_KEY_PREFIX = "reminder:";
function reminderKey(id: string): string {
  return `${REMINDER_KEY_PREFIX}${id}`;
}

function generateId(): string {
  return `rem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function createReminder(phone: string, text: string, dueAt: number): Promise<Reminder> {
  const reminder: Reminder = {
    id: generateId(),
    phone,
    text,
    dueAt,
    fired: false,
    createdAt: Date.now(),
  };
  await kvSet(reminderKey(reminder.id), reminder);
  return reminder;
}

export async function getAllReminders(): Promise<Reminder[]> {
  return kvGetAllWithPrefix<Reminder>(REMINDER_KEY_PREFIX);
}

export async function markReminderFired(id: string): Promise<void> {
  const existing = await kvGet<Reminder>(reminderKey(id));
  if (!existing) return;
  await kvSet(reminderKey(id), { ...existing, fired: true });
}

export async function deleteReminder(id: string): Promise<void> {
  await kvDelete(reminderKey(id));
}
