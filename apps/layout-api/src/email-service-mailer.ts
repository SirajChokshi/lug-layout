import type { IMailer, SignInMail } from "./mailer.ts";

export const SENDER_NAME = "Brick Railroad";
export const SIGN_IN_SUBJECT = "Your Brick Railroad sign-in link";

export function signInText(mail: SignInMail): string {
  return [
    "Open this link to sign in to Brick Railroad:",
    "",
    mail.link,
    "",
    `The link works once and expires in ${mail.lifetimeMinutes} minutes.`,
    "If you didn't ask to sign in, ignore this email. Nobody can sign in without the link.",
    "",
  ].join("\n");
}

export class EmailServiceMailer implements IMailer {
  constructor(
    private readonly binding: SendEmail,
    private readonly from: string,
  ) {}

  async sendSignIn(mail: SignInMail): Promise<void> {
    await this.binding.send({
      from: { name: SENDER_NAME, email: this.from },
      to: mail.to,
      subject: SIGN_IN_SUBJECT,
      text: signInText(mail),
    });
  }
}
