export type MemoryCategory = 'size_fit' | 'preference' | 'profile' | 'feedback' | 'shop_policy';
export type UserRole = 'buyer' | 'seller';

export interface UserMemory {
  id: string;
  userId: string;
  role: UserRole;
  category: MemoryCategory;
  importance: number;
  content: string;
  searchText: string;
  supersededAt?: Date | null;
  supersededBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchHit {
  id: string;
  category: MemoryCategory;
  content: string;
  importance: number;
  score: number;
}
