export type FanficProfileStage = 'writing' | 'planning' | 'memory' | 'review' | 'rewrite';
export type FanficModelKind = 'generic' | 'dense' | 'moe';
export interface FanficStageOverride { maxTokens?: number; temperature?: number }
export interface FanficGenerationProfiles { modelKind: FanficModelKind; stages: Partial<Record<FanficProfileStage, FanficStageOverride>> }
export interface FanficStageProfile { stage: FanficProfileStage; modelKind: FanficModelKind; maxTokens: number; temperature: number; overridden: string[] }
export const FANFIC_PROFILE_STAGES: readonly FanficProfileStage[];
export const FANFIC_MODEL_KINDS: readonly FanficModelKind[];
export const FANFIC_PROFILE_DEFAULTS: Readonly<Record<FanficModelKind, Readonly<Record<FanficProfileStage, Readonly<FanficStageOverride>>>>>;
export function normalizeFanficProfiles(value?: unknown): FanficGenerationProfiles;
export function resolveFanficStageProfile(settings?: {generationProfiles?: unknown;maxTokens?: number;temperature?: number},stage?: FanficProfileStage,options?: {contextWindow?: number;maxTokensFallback?: number;temperatureFallback?: number}): FanficStageProfile;
