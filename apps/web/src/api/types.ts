export type Workspace = {
  id: string;
  name: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  _count?: { balconies: number; plants: number; observations: number };
};

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  locale: string;
  status: 'ACTIVE' | 'DELETING' | 'DELETED';
};

export type Balcony = {
  id: string;
  workspaceId: string;
  name: string;
  orientation?: string | null;
  floor?: number | null;
  notes?: string | null;
  zones: Zone[];
};

export type Zone = {
  id: string;
  balconyId: string;
  name: string;
  description?: string | null;
  sunExposure?: string | null;
  sortOrder: number;
};

export type Plant = {
  id: string;
  workspaceId: string;
  zoneId: string;
  name: string;
  species?: string | null;
  variety?: string | null;
  status: string;
  zone: Zone;
  coverPhoto?: Photo | null;
};

export type Photo = {
  id: string;
  workspaceId: string;
  objectKey: string;
  thumbnailKey?: string | null;
  originalFilename: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  capturedAt?: string | null;
  uploadedAt: string;
  plantId?: string | null;
  zoneId?: string | null;
};

export type Observation = {
  id: string;
  workspaceId: string;
  balconyId: string;
  zoneId: string;
  plantId?: string | null;
  observedAt: string;
  temperatureC: string | number;
  lightLevel: string;
  lux?: number | null;
  windDirection: string;
  windDegrees?: number | null;
  windSpeedMps?: string | number | null;
  plantStatus: string;
  plantTags: string[];
  notes?: string | null;
  zone: Zone;
  plant?: Plant | null;
  photos?: Photo[];
};

export type ActionLog = {
  id: string;
  workspaceId: string;
  balconyId: string;
  zoneId?: string | null;
  plantId?: string | null;
  actionType: string;
  title: string;
  startedAt: string;
  completedAt?: string | null;
  parametersJson: Record<string, unknown>;
  notes?: string | null;
  zone?: Zone | null;
  plant?: Plant | null;
  photos?: Photo[];
};

export type Reminder = {
  id: string;
  workspaceId: string;
  title: string;
  reminderType: string;
  targetType: string;
  triggerMode: string;
  timezone: string;
  intervalValue?: number | null;
  intervalUnit?: string | null;
  timeOfDay?: string | null;
  nextRunAt?: string | null;
  isActive: boolean;
  channelMask: string[];
  plant?: Plant | null;
  zone?: Zone | null;
};

export type ReminderOccurrence = {
  id: string;
  reminderId: string;
  dueAt: string;
  status: string;
  sentAt?: string | null;
  handledAt?: string | null;
  snoozedUntil?: string | null;
  reminder: Reminder;
};

export type Notification = {
  id: string;
  title: string;
  body: string;
  readAt?: string | null;
  createdAt: string;
};
