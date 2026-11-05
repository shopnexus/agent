export type MemoryCategory = 'size_fit' | 'preference' | 'profile' | 'feedback';

export interface UserMemory {
  id: string;
  userId: string;
  category: MemoryCategory;
  importance: number;
  content: string;
  searchText: string;
  supersededAt?: Date | null;
  supersededBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
  factKey?: string | null;
  expiresAt?: Date | null;
  deletedAt?: Date | null;
}

export interface SearchHit {
  id: string;
  category: MemoryCategory;
  content: string;
  importance: number;
  score: number;
}
