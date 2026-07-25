import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'baudtide.notifications.v1';
const MAX_NOTIFICATIONS = 60;

export type NotificationKind = 'connection' | 'error' | 'export';

export type AppNotification = {
  id: string;
  title: string;
  detail: string;
  kind: NotificationKind;
  createdAt: string;
  read: boolean;
};

function loadNotifications(): AppNotification[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AppNotification => (
      typeof item === 'object' && item !== null
      && typeof item.id === 'string' && typeof item.title === 'string'
      && typeof item.detail === 'string' && typeof item.createdAt === 'string'
      && typeof item.read === 'boolean'
      && (item.kind === 'connection' || item.kind === 'error' || item.kind === 'export')
    )).slice(0, MAX_NOTIFICATIONS);
  } catch {
    return [];
  }
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>(loadNotifications);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
    } catch {
      // Notifications remain available for this session if local storage is unavailable.
    }
  }, [notifications]);

  const publish = useCallback((notification: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => {
    const next: AppNotification = {
      ...notification,
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      read: false,
    };
    setNotifications((current) => [next, ...current].slice(0, MAX_NOTIFICATIONS));
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((current) => current.map((notification) => notification.id === id
      ? { ...notification, read: true }
      : notification));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
  }, []);

  return { notifications, publish, markRead, markAllRead };
}
