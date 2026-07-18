import type { LucideIcon } from 'lucide-react';

export type SignalDeckPage = 'dashboard' | 'sessions' | 'logs' | 'preferences' | 'help';

export type NavigationItem = {
  id: SignalDeckPage;
  label: string;
  icon: LucideIcon;
  badge?: string;
};

export type Workspace = {
  id: string;
  name: string;
  description: string;
  initial: string;
};
