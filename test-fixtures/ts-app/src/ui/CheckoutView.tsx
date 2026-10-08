import { PaymentService } from '../services/paymentService';

export class CheckoutView {
  constructor(private payments: PaymentService) {}

  onPayClicked(userId: string) {
    this.payments.charge(userId, 10);
  }
}

export function formatPrice(n: number) {
  return '$' + n.toFixed(2);
}
