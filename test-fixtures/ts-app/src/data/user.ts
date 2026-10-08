export interface User {
  id: string;
  name: string;
  balance: number;
}

export class UserRepository {
  private users = new Map<string, User>();
  get(id: string): User | undefined {
    return this.users.get(id);
  }
  save(u: User): void {
    this.users.set(u.id, u);
  }
}
