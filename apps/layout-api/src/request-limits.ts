export interface IRequestLimits {
  allowSignIn(clientAddress: string): Promise<boolean>;
  allowAccount(accountId: string): Promise<boolean>;
}

export class RateLimitBindings implements IRequestLimits {
  constructor(
    private readonly signIn: RateLimit,
    private readonly account: RateLimit,
  ) {}

  async allowSignIn(clientAddress: string): Promise<boolean> {
    return (await this.signIn.limit({ key: clientAddress })).success;
  }

  async allowAccount(accountId: string): Promise<boolean> {
    return (await this.account.limit({ key: accountId })).success;
  }
}
