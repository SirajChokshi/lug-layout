import type { EmailAddress } from "@brr/schema/layout-api";

export interface SignInMail {
  readonly to: EmailAddress;
  readonly link: string;
  readonly lifetimeMinutes: number;
}

export interface IMailer {
  sendSignIn(mail: SignInMail): Promise<void>;
}
