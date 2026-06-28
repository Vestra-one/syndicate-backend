import type { ProfileStats } from './index.ts';

export interface ProfileMetadata {
  wallet: string;
  handle?: string;
  avatarUri?: string;
  updatedAt: number;
}

const metadata = new Map<string, ProfileMetadata>();

export function getProfileMetadata(wallet: string): ProfileMetadata | undefined {
  return metadata.get(wallet);
}

export function upsertProfileMetadata(wallet: string, input: { handle?: string; avatarUri?: string }): ProfileMetadata {
  const current = metadata.get(wallet) ?? { wallet, updatedAt: Date.now() };
  const next: ProfileMetadata = {
    ...current,
    handle: input.handle ?? current.handle,
    avatarUri: input.avatarUri ?? current.avatarUri,
    updatedAt: Date.now(),
  };
  metadata.set(wallet, next);
  return next;
}

export function toPublicProfile(wallet: string, stats?: ProfileStats, meta?: ProfileMetadata) {
  const s = stats ?? {
    userId: wallet,
    publicHandle: meta?.handle ?? wallet.slice(0, 8),
    matchesPlayed: 0,
    matchesWon: 0,
    totalBuyIn: 0,
    totalPayout: 0,
    showdownCount: 0,
    foldCount: 0,
    achievementCount: 0,
    updatedAt: Date.now(),
  };
  return {
    userId: wallet,
    handle: meta?.handle ?? s.publicHandle,
    avatarUri: meta?.avatarUri,
    stats: {
      matchesPlayed: s.matchesPlayed,
      matchesWon: s.matchesWon,
      totalBuyIn: s.totalBuyIn,
      totalPayout: s.totalPayout,
      showdownCount: s.showdownCount,
      foldCount: s.foldCount,
      achievementCount: s.achievementCount,
    },
  };
}
