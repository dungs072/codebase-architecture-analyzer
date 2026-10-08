import { Container } from 'inversify';
import { PaymentService } from './services/paymentService';
import { UserRepository } from './data/user';

export const container = new Container();
container.bind<PaymentService>(PaymentService).toSelf().inSingletonScope();
container.bind<UserRepository>(UserRepository).toSelf().inSingletonScope();
