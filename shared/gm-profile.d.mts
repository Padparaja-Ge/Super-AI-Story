export type GmProfile = 'standard' | 'mark-vedin' | 'lev-krechet' | 'mira-rostova';
export type CampaignDeathPolicy = 'classic' | 'replace' | 'end';
export interface GmSettings { profile: GmProfile; deathPolicy: CampaignDeathPolicy }
export const gmProfiles: Readonly<Record<GmProfile, { name: string; description: string; instruction: string }>>;
export const campaignDeathPolicies: Readonly<Record<CampaignDeathPolicy, string>>;
export function normalizeGmSettings(value?: unknown): GmSettings;
