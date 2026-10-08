import { injectable } from 'inversify';
import { UserRepository, User } from '../data/user';
import { EventEmitter } from 'events';

@injectable()
export class PaymentService {
  readonly events = new EventEmitter();
  constructor(private readonly repo: UserRepository) {}

  charge(userId: string, amount: number): boolean {
    const user: User | undefined = this.repo.get(userId);
    if (!user || user.balance < amount) return false;
    user.balance -= amount;
    this.repo.save(user);
    this.events.emit('charged', user);
    return true;
  }
}
