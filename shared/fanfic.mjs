// Fanfic settings belong to a project, never to ordinary chats or multiplayer.
export const fanficDefaults = Object.freeze({
  connectionId: '', style: 'Живая художественная проза, конкретные детали и естественные диалоги',
  perspective: 'Третье лицо', tense: 'Прошедшее', genre: '', audience: 'Общая аудитория',
  instructions: '', sceneCount: 3, maxTokens: 1200, temperature: 0.8, vectorMemory: false,
  memoryTopK: 8, memoryThreshold: 0.3, memoryRecentEpisodes: 2, continuityCheck:true,
  generationProfiles:Object.freeze({modelKind:'generic',stages:Object.freeze({})}),
});

export function fanficEpisodeOrder(a, b) {
  return Number(a.season || 1) - Number(b.season || 1) || Number(a.number || 1) - Number(b.number || 1)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id));
}

export function fanficEpisodeLabel(episode) {
  return `Сезон ${episode.season || 1} · эпизод ${episode.number || 1}${episode.title ? ' · ' + episode.title : ''}`;
}
